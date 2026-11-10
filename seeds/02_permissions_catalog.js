exports.seed = async function (knex) {
  const permissions = [
    // ═══════════════ MEDICINES FEATURE ═══════════════
    {
      permission_key: 'pharmacy.medicines.view',
      permission_name: 'View Medicines',
      feature_key: 'medicines',
      module_key: 'pharmacy',
      action: 'view',
      is_active: 1,
    },
    {
      permission_key: 'pharmacy.medicines.create',
      permission_name: 'Create Medicine',
      feature_key: 'medicines',
      module_key: 'pharmacy',
      action: 'create',
      is_active: 1,
    },
    {
      permission_key: 'pharmacy.medicines.edit',
      permission_name: 'Edit Medicine',
      feature_key: 'medicines',
      module_key: 'pharmacy',
      action: 'edit',
      is_active: 1,
    },
    {
      permission_key: 'pharmacy.medicines.delete',
      permission_name: 'Delete Medicine',
      feature_key: 'medicines',
      module_key: 'pharmacy',
      action: 'delete',
      is_active: 1,
    },
    {
      permission_key: 'pharmacy.medicines.export',
      permission_name: 'Export Medicines',
      feature_key: 'medicines',
      module_key: 'pharmacy',
      action: 'export',
      is_active: 1,
    },

    // ═══════════════ SUPPLIERS FEATURE ═══════════════
    {
      permission_key: 'pharmacy.suppliers.view',
      permission_name: 'View Suppliers',
      feature_key: 'suppliers',
      module_key: 'pharmacy',
      action: 'view',
      is_active: 1,
    },
    {
      permission_key: 'pharmacy.suppliers.create',
      permission_name: 'Create Supplier',
      feature_key: 'suppliers',
      module_key: 'pharmacy',
      action: 'create',
      is_active: 1,
    },
    {
      permission_key: 'pharmacy.suppliers.edit',
      permission_name: 'Edit Supplier',
      feature_key: 'suppliers',
      module_key: 'pharmacy',
      action: 'edit',
      is_active: 1,
    },
    {
      permission_key: 'pharmacy.suppliers.delete',
      permission_name: 'Delete Supplier',
      feature_key: 'suppliers',
      module_key: 'pharmacy',
      action: 'delete',
      is_active: 1,
    },

    // ═══════════════ SALES FEATURE ═══════════════
    {
      permission_key: 'pharmacy.sales.view',
      permission_name: 'View Sales',
      feature_key: 'sales',
      module_key: 'pharmacy',
      action: 'view',
      is_active: 1,
    },
    {
      permission_key: 'pharmacy.sales.create',
      permission_name: 'Create Sale',
      feature_key: 'sales',
      module_key: 'pharmacy',
      action: 'create',
      is_active: 1,
    },
    {
      permission_key: 'pharmacy.sales.edit',
      permission_name: 'Edit Sale',
      feature_key: 'sales',
      module_key: 'pharmacy',
      action: 'edit',
      is_active: 1,
    },
    {
      permission_key: 'pharmacy.sales.delete',
      permission_name: 'Delete Sale',
      feature_key: 'sales',
      module_key: 'pharmacy',
      action: 'delete',
      is_active: 1,
    },
    {
      permission_key: 'pharmacy.sales.export',
      permission_name: 'Export Sales',
      feature_key: 'sales',
      module_key: 'pharmacy',
      action: 'export',
      is_active: 1,
    },
    {
      permission_key: 'pharmacy.sales.approve',
      permission_name: 'Approve Sale',
      feature_key: 'sales',
      module_key: 'pharmacy',
      action: 'approve',
      is_active: 1,
    },

    // ═══════════════ PURCHASE FEATURE ═══════════════
    {
      permission_key: 'pharmacy.purchase.view',
      permission_name: 'View Purchase Orders',
      feature_key: 'purchase',
      module_key: 'pharmacy',
      action: 'view',
      is_active: 1,
    },
    {
      permission_key: 'pharmacy.purchase.create',
      permission_name: 'Create Purchase Order',
      feature_key: 'purchase',
      module_key: 'pharmacy',
      action: 'create',
      is_active: 1,
    },
    {
      permission_key: 'pharmacy.purchase.edit',
      permission_name: 'Edit Purchase Order',
      feature_key: 'purchase',
      module_key: 'pharmacy',
      action: 'edit',
      is_active: 1,
    },
    {
      permission_key: 'pharmacy.purchase.delete',
      permission_name: 'Delete Purchase Order',
      feature_key: 'purchase',
      module_key: 'pharmacy',
      action: 'delete',
      is_active: 1,
    },
    {
      permission_key: 'pharmacy.purchase.export',
      permission_name: 'Export Purchase Orders',
      feature_key: 'purchase',
      module_key: 'pharmacy',
      action: 'export',
      is_active: 1,
    },
    {
      permission_key: 'pharmacy.purchase.approve',
      permission_name: 'Approve Purchase Order',
      feature_key: 'purchase',
      module_key: 'pharmacy',
      action: 'approve',
      is_active: 1,
    },

    // ═══════════════ REPORTS FEATURE ═══════════════
    {
      permission_key: 'pharmacy.reports.view',
      permission_name: 'View Reports',
      feature_key: 'reports',
      module_key: 'pharmacy',
      action: 'view',
      is_active: 1,
    },
    {
      permission_key: 'pharmacy.reports.export',
      permission_name: 'Export Reports',
      feature_key: 'reports',
      module_key: 'pharmacy',
      action: 'export',
      is_active: 1,
    },
  ];

  await knex('permissions')
    .insert(permissions)
    .onConflict('permission_key')
    .ignore();

  console.log(`Seeded ${permissions.length} pharmacy permissions (existing ones skipped)`);
};