module default {
  scalar type Role extending enum<USER, ADMIN>;

  type User {
    required property id -> int32;
    required property email -> str {
      constraint exclusive;
    };
    property name -> str;
    required property role -> Role {
      default := Role.USER;
    };
    multi link posts := .<author[is Post];
    link profile := .<user[is Profile];
  }

  type Profile {
    required property id -> int32;
    required property bio -> str;
    required link user -> User;
  }

  type Post {
    required property id -> int32;
    required property createdAt -> datetime {
      default := datetime_current();
    };
    required property title -> str;
    required property published -> bool {
      default := false;
    };
    required link author -> User;
    multi link categories -> Category;
  }

  type Category {
    required property id -> int32;
    required property name -> str;
    multi link posts -> Post;
  }
}
