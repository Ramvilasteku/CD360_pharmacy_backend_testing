/**
 * @type { Object.<string, import("knex").Knex.Config> }
 */

module.exports = {
  development: {
    client: "mysql2",
    connection: {
      host: "localhost",
      user: "root",
      password: "Root",
      database: "caredesk360",
    },
    pool: {
      min: 2,
      max: 10,
    },
    migrations: {
      directory: "./database/migrations",
      tableName: "knex_migrations",
    },
  },

  staging: {
    client: "mysql2",
    connection: {
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    },
    pool: {
      min: 2,
      max: 10,
    },
    migrations: {
      directory: "./database/migrations",
      tableName: "knex_migrations",
    },
  },

  production: {
    client: "mysql2",
    connection: {
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    },
    pool: {
      min: 2,
      max: 10,
    },
    migrations: {
      directory: "./database/migrations",
      tableName: "knex_migrations",
    },
    seeds: {                          
      directory: './seeds',
    },
  },
};


exports.up = async function (knex) {
  // Check if table already exists (for your database)
  const exists = await knex.schema.hasTable('user_role_assignments');

  if (exists) {
    console.log('Table user_role_assignments already exists — skipping creation');
    return;
  }

  // Only runs on databases that DON'T have the table (teammate's DB)
  await knex.schema.createTable('user_role_assignments', (table) => {
    // id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY
    table.increments('id').unsigned().primary();

    // user_id INT UNSIGNED NOT NULL
    table.integer('user_id').unsigned().notNullable();

    // user_type ENUM('admin','staff','client') NOT NULL
    table.enum('user_type', ['admin', 'staff', 'client']).notNullable();

    // role_id INT UNSIGNED NOT NULL
    table.integer('role_id').unsigned().notNullable();

    // is_primary TINYINT(1) NOT NULL DEFAULT 0
    table.tinyint('is_primary', 1).notNullable().defaultTo(0);

    // assigned_by INT UNSIGNED (nullable)
    table.integer('assigned_by').unsigned().nullable();

    // status TINYINT(1) NOT NULL DEFAULT 1
    table.tinyint('status', 1).notNullable().defaultTo(1);

    // created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    // updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    table
      .timestamp('updated_at')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

    // UNIQUE KEY uq_user_role (user_id, user_type, role_id)
    table.unique(['user_id', 'user_type', 'role_id'], 'uq_user_role');

    // KEY idx_user (user_id, user_type)
    table.index(['user_id', 'user_type'], 'idx_user');

    // KEY idx_role (role_id)
    table.index(['role_id'], 'idx_role');
  });

  console.log('Table user_role_assignments created');
};

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('user_role_assignments');
};