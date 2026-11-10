// utils/seedSystemRoles.js

const db = require("../db");

const SYSTEM_ROLE_MAP = {
  clinic: [
    {
      role_key: "doctor",
      role_name: "Doctor",
      description: "System role for doctors",
    },
    {
      role_key: "receptionist",
      role_name: "Receptionist",
      description: "System role for receptionists",
    },
  ],

  hospital: [
    {
      role_key: "doctor",
      role_name: "Doctor",
      description: "System role for doctors",
    },
    {
      role_key: "receptionist",
      role_name: "Receptionist",
      description: "System role for receptionists",
    },
  ],
};

async function seedSystemRolesForAdmin(adminId, adminType, connection = db) {
  if (!adminId || !adminType) {
    return [];
  }

  const normalizedType = String(adminType).trim().toLowerCase();
  const roles = SYSTEM_ROLE_MAP[normalizedType];

  // Pharmacy and unsupported types receive no Clinic/Hospital roles.
  if (!roles) {
    return [];
  }

  const createdRoles = [];

  for (const role of roles) {
    const [existing] = await connection.execute(
      `SELECT id FROM roles
       WHERE admin_id = ? AND role_key = ?
       LIMIT 1`,
      [adminId, role.role_key]
    );

    if (existing.length) {
      continue;
    }

    const [result] = await connection.execute(
      `INSERT INTO roles
       (admin_id, role_key, role_name, description, is_system_role, status)
       VALUES (?, ?, ?, ?, 1, 1)`,
      [
        adminId,
        role.role_key,
        role.role_name,
        role.description,
      ]
    );

    createdRoles.push({
      id: result.insertId,
      role_key: role.role_key,
      role_name: role.role_name,
    });
  }

  return createdRoles;
}

module.exports = { seedSystemRolesForAdmin };