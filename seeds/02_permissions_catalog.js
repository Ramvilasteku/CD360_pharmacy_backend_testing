// seeds/02_permissions_catalog.js
//
// L7 (10 Nov 2026): brought in line with the permission catalogue v3 (6 Nov 2026) —
// exactly the 46 keys the pharmacy routes check, one per feature + action (the Roles
// screen shows one checkbox per feature + action, so two keys sharing a pair collide).
// The old version had 23 keys, missed B2B, sales returns, purchase transfer, payments
// and inventory, and still carried approve/export keys no route checks.
//
// Insert-only: existing rows (and their ids, which role grants point at) are left alone.
exports.seed = async function (knex) {
  const p = (feature_key, area, action, permission_key, label) => ({
    permission_key,
    permission_name: `${area} — ${label}`,
    feature_key,
    module_key: "pharmacy",
    action,
    is_active: 1,
  });

  const permissions = [
    // Medicines
    p("medicines", "Medicines", "view", "pharmacy.medicines.view", "View"),
    p(
      "medicines",
      "Medicines",
      "create",
      "pharmacy.medicines.create",
      "Create",
    ),
    p("medicines", "Medicines", "edit", "pharmacy.medicines.edit", "Edit"),
    p(
      "medicines",
      "Medicines",
      "delete",
      "pharmacy.medicines.delete",
      "Delete",
    ),
    // Inventory
    p("inventory", "Inventory", "view", "pharmacy.stock.view", "View"),
    p(
      "inventory",
      "Inventory",
      "create",
      "pharmacy.stock.create",
      "Adjust / add stock",
    ),
    // Sales
    p("sales", "Sales", "view", "pharmacy.sales.view", "View"),
    p("sales", "Sales", "create", "pharmacy.sales.create", "Create (bill)"),
    p("sales", "Sales", "edit", "pharmacy.sales.edit", "Edit"),
    p("sales", "Sales", "cancel", "pharmacy.sales.cancel", "Cancel"),
    p("sales", "Sales", "delete", "pharmacy.sales.delete", "Delete"),
    // Customers
    p("customers", "Customers", "view", "pharmacy.customers.view", "View"),
    p(
      "customers",
      "Customers",
      "create",
      "pharmacy.customers.create",
      "Create",
    ),
    p("customers", "Customers", "edit", "pharmacy.customers.edit", "Edit"),
    p(
      "customers",
      "Customers",
      "delete",
      "pharmacy.customers.delete",
      "Delete",
    ),
    // Sales returns
    p(
      "sales-returns",
      "Sales returns",
      "view",
      "pharmacy.sales-returns.view",
      "View",
    ),
    p(
      "sales-returns",
      "Sales returns",
      "create",
      "pharmacy.sales-returns.create",
      "Create",
    ),
    p(
      "sales-returns",
      "Sales returns",
      "edit",
      "pharmacy.sales-returns.edit",
      "Edit",
    ),
    p(
      "sales-returns",
      "Sales returns",
      "cancel",
      "pharmacy.sales-returns.cancel",
      "Cancel",
    ),
    p(
      "sales-returns",
      "Sales returns",
      "override",
      "pharmacy.sales-returns.override",
      "Accept past the return window",
    ),
    // Payments
    p("payments", "Payments", "view", "pharmacy.payments.view", "View"),
    p("payments", "Payments", "create", "pharmacy.payments.create", "Create"),
    p("payments", "Payments", "update", "pharmacy.payments.update", "Update"),
    p("payments", "Payments", "delete", "pharmacy.payments.delete", "Delete"),
    // Purchase
    p("purchase", "Purchase", "view", "pharmacy.purchase.view", "View"),
    p("purchase", "Purchase", "create", "pharmacy.purchase.create", "Create"),
    p("purchase", "Purchase", "edit", "pharmacy.purchase.edit", "Edit"),
    p("purchase", "Purchase", "delete", "pharmacy.purchase.delete", "Delete"),
    p(
      "purchase",
      "Purchase",
      "generate_PO",
      "pharmacy.purchase.generate_create",
      "Generate PO",
    ),
    p(
      "purchase",
      "Purchase",
      "sale_based_order",
      "pharmacy.purchase.salebased_create",
      "Sale-based order",
    ),
    p(
      "purchase",
      "Purchase",
      "receive_PO",
      "pharmacy.purchase.receive",
      "Receive PO",
    ),
    // Purchase returns
    p(
      "purchase_return",
      "Purchase returns",
      "view",
      "pharmacy.purchase_return.view",
      "View",
    ),
    p(
      "purchase_return",
      "Purchase returns",
      "create",
      "pharmacy.purchase_return.create",
      "Create",
    ),
    p(
      "purchase_return",
      "Purchase returns",
      "edit",
      "pharmacy.purchase_return.edit",
      "Edit",
    ),
    // Purchase transfer
    p(
      "purchase_transfer",
      "Purchase transfer",
      "view",
      "pharmacy.purchase_transfer.view",
      "View",
    ),
    p(
      "purchase_transfer",
      "Purchase transfer",
      "create",
      "pharmacy.purchase_transfer.create",
      "Create",
    ),
    p(
      "purchase_transfer",
      "Purchase transfer",
      "edit",
      "pharmacy.purchase_transfer.edit",
      "Edit",
    ),
    // B2B sales
    p("b2b_sales", "B2B sales", "view", "pharmacy.b2b_sales.view", "View"),
    p(
      "b2b_sales",
      "B2B sales",
      "create",
      "pharmacy.b2b_sales.create",
      "Create",
    ),
    p("b2b_sales", "B2B sales", "edit", "pharmacy.b2b_sales.edit", "Edit"),
    // Suppliers
    p("suppliers", "Suppliers", "view", "pharmacy.suppliers.view", "View"),
    p(
      "suppliers",
      "Suppliers",
      "create",
      "pharmacy.suppliers.create",
      "Create",
    ),
    p("suppliers", "Suppliers", "edit", "pharmacy.suppliers.edit", "Edit"),
    p(
      "suppliers",
      "Suppliers",
      "delete",
      "pharmacy.suppliers.delete",
      "Delete",
    ),
    // Reports
    p("reports", "Reports", "view", "pharmacy.reports.view", "View"),
    p("reports", "Reports", "export", "pharmacy.reports.export", "Export"),
  ];

  await knex("permissions")
    .insert(permissions)
    .onConflict("permission_key")
    .ignore();

  console.log(
    `Seeded ${permissions.length} pharmacy permissions (existing ones skipped)`,
  );
};
