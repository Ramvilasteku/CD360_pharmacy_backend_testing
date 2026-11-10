/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> } 
 */
exports.seed = async function (knex) {
  const features = [
    {
      feature_key: 'medicines',
      feature_name: 'Medicines',
      module_key: 'pharmacy',
      description: 'Manage pharmacy medicine inventory and catalog',
      display_order: 1,
      is_active: 1,
    },
    {
      feature_key: 'suppliers',
      feature_name: 'Suppliers',
      module_key: 'pharmacy',
      description: 'Manage medicine suppliers and vendor relationships',
      display_order: 2,
      is_active: 1,
    },
    {
      feature_key: 'sales',
      feature_name: 'Sales',
      module_key: 'pharmacy',
      description: 'Manage pharmacy sales transactions and billing',
      display_order: 3,
      is_active: 1,
    },
    {
      feature_key: 'purchase',
      feature_name: 'Purchase Orders',
      module_key: 'pharmacy',
      description: 'Manage purchase orders from suppliers and stock ordering',
      display_order: 4,
      is_active: 1,
    },
    {
      feature_key: 'reports',
      feature_name: 'Reports',
      module_key: 'pharmacy',
      description: 'View and export pharmacy analytics and reports',
      display_order: 5,
      is_active: 1,
    },
  ];

  await knex('features')
    .insert(features)
    .onConflict('feature_key')
    .ignore();

  console.log(`Seeded ${features.length} pharmacy features (existing ones skipped)`);
};
