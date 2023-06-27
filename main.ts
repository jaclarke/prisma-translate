import fs from "fs/promises";
import {
  Enum,
  getSchema,
  Schema,
  Enumerator,
  Model,
  Field,
  ModelAttribute,
  GroupedModelAttribute,
  Func,
  Property,
  Attribute,
  KeyValue,
} from "@mrleebo/prisma-ast";

const SCHEMA_PATH = "./example_schema.prisma";
const OUTPUT_PATH = "./example_schema.esdl";

(async function () {
  const source = await fs.readFile(SCHEMA_PATH, "utf8");

  const prismaSchema = getSchema(source);

  const edbSchema = translateSchema(prismaSchema);

  await fs.writeFile(OUTPUT_PATH, renderSchemaAst(edbSchema));
})();

interface SchemaAst {
  enums: Map<string, EnumAst>;
  types: Map<string, ObjectTypeAst>;
}

interface EnumAst {
  values: string[];
}

interface ObjectTypeAst {
  props: Map<string, PointerAst>;
  links: Map<string, PointerAst>;
  backlinks: Map<string, { expr: string; multi: boolean }>;
  linkIds: Set<string>;
}

interface PointerAst {
  kind: "property" | "link";
  multi: boolean;
  required: boolean;
  type: string;
  exclusive: boolean;
  default: string | null;
}

type ExtendedField = Field & { attrs: { [key: string]: Attribute } };

function translateSchema(schema: Schema): SchemaAst {
  const edbSchema: SchemaAst = {
    enums: new Map(),
    types: new Map(),
  };

  const enums = schema.list.filter((block) => block.type === "enum") as Enum[];
  for (const enumBlock of enums) {
    edbSchema.enums.set(enumBlock.name, {
      values: (
        enumBlock.enumerators.filter(
          (item) => item.type === "enumerator"
        ) as Enumerator[]
      ).map((item) => item.name),
    });
  }

  const models = schema.list.reduce((models, model) => {
    if (model.type === "model") {
      models[model.name] = {
        ...model,
        fields: model.properties.reduce((fields, prop) => {
          if (prop.type === "field") {
            fields[prop.name] = {
              ...prop,
              attrs:
                prop.attributes?.reduce((attrs, attr) => {
                  attrs[attr.name] = attr;
                  return attrs;
                }, {}) ?? [],
            };
          }
          return fields;
        }, {}),
      };
    }
    return models;
  }, {} as { [key: string]: Model & { fields: { [key: string]: ExtendedField } } });

  for (const model of Object.values(models)) {
    const edbType: ObjectTypeAst = {
      props: new Map(),
      links: new Map(),
      backlinks: new Map(),
      linkIds: new Set(),
    };
    edbSchema.types.set(model.name, edbType);

    for (const field of Object.values(model.fields)) {
      const isLink =
        typeof field.fieldType === "string" && models[field.fieldType];

      if (isLink) {
        const target = models[field.fieldType as string];
        if (!target) {
          throw Error(
            `no target for link ${field.name} with type ${field.fieldType}`
          );
        }

        const linkPair = Object.values(target.fields).filter(
          (field) => field.attrs["relation"] && field.fieldType === model.name
        );
        if (linkPair.length > 1) {
          throw new Error(`multiple possible backlinks`);
        }
        if (linkPair.length) {
          edbType.backlinks.set(field.name, {
            expr: `.<${linkPair[0].name}[is ${target.name}];`,
            multi: !!field.array,
          });
          continue;
        }

        const idFields = field.attrs["relation"]?.args?.find(
          (arg) =>
            (arg.value as KeyValue).type === "keyValue" &&
            (arg.value as KeyValue).key === "fields"
        )?.value as KeyValue;
        if (idFields) {
          if ((idFields.value as any).args.length !== 1) {
            throw new Error(`not supported: composite ids`);
          }
          edbType.linkIds.add((idFields.value as any).args[0]);
        }
      }

      const edbPointer: PointerAst = {
        kind: isLink ? "link" : "property",
        // Prisma has two type modifiers: optional and list.
        // Prisma docs state: "You cannot combine type modifiers -
        // optional lists are not supported."
        // It seems lists in prisma can always be empty though, so in edgedb
        // schema 'multi' should always be optional.
        multi: !!field.array,
        required: field.array ? false : !field.optional,
        type:
          isLink ||
          (typeof field.fieldType === "string" &&
            edbSchema.enums.has(field.fieldType))
            ? field.fieldType
            : mapPrismaTypeToEdgeDBScalar(field.fieldType),
        exclusive: !!field.attrs["unique"],
        default: getFieldDefault(edbSchema, field),
      };

      (isLink ? edbType.links : edbType.props).set(field.name, edbPointer);
    }
  }

  return edbSchema;
}

function getFieldDefault(
  schema: SchemaAst,
  field: ExtendedField
): string | null {
  const def = field.attrs["default"]?.args?.[0];
  if (!def) {
    return null;
  }
  if (typeof def.value === "string") {
    if (schema.enums.has(field.fieldType as string)) {
      return `${field.fieldType}.${def.value}`;
    }
    switch (field.fieldType) {
      case "String":
        return JSON.stringify(def.value);
      case "Boolean":
        return def.value;
    }
  } else if ((def.value as any).type === "function") {
    switch ((def.value as any).name as string) {
      case "now":
        return "datetime_current()";
      case "uuid":
        return "uuid_generate_v4()";
    }
  }
  return null;
}

function renderSchemaAst(schema: SchemaAst): string {
  const enums = [...schema.enums].map(
    ([name, enumType]) =>
      `  scalar type ${name} extending enum<${enumType.values.join(", ")}>;`
  );
  const types = [...schema.types.entries()].map(
    ([name, objType]) =>
      `  type ${name} {\n${[
        ...[...objType.props, ...objType.links]
          .filter(([name]) => !objType.linkIds.has(name))
          .map(([name, pointer]) => {
            const attrs: string[] = [];
            if (pointer.exclusive) {
              attrs.push(`      constraint exclusive;`);
            }
            if (pointer.default != null) {
              attrs.push(`      default := ${pointer.default};`);
            }
            return `    ${pointer.required ? "required " : ""}${
              pointer.multi ? "multi " : ""
            }${pointer.kind} ${name} -> ${pointer.type}${
              attrs.length ? ` {\n${attrs.join("\n")}\n    }` : ""
            };`;
          }),
        ...[...objType.backlinks].map(
          ([name, backlink]) =>
            `    ${backlink.multi ? "multi " : ""}link ${name} := ${
              backlink.expr
            }`
        ),
      ].join("\n")}\n  }`
  );
  return `module default {\n${[...enums, ...types].join("\n\n")}\n}\n`;
}

const typeMapping = {
  String: "str",
  Boolean: "bool",
  Int: "int32",
  BigInt: "int64",
  Float: "float64",
  Decimal: "decimal",
  DateTime: "datetime",
  Json: "json",
  Bytes: "bytes",
};

function mapPrismaTypeToEdgeDBScalar(type: string | Func) {
  if (typeof type !== "string") {
    throw new Error(
      `unknown 'Func' type '${type.name}(${type.params
        .map((p) => p.toString())
        .join(", ")})'`
    );
  }
  const edbType = typeMapping[type];
  if (!edbType) {
    throw new Error(`unknown type '${type}'`);
  }
  return edbType;
}
