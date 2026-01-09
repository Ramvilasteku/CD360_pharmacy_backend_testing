const bcrypt = require("bcryptjs");

async function generateHash(password) {
  const hash = await bcrypt.hash(password, 10);
  console.log(hash);
}

generateHash("Admin@123");  // <-- hash this password for Ankit
generateHash("Priya@123");  // <-- hash this password for Neha
generateHash("Rohit@123");  // <-- hash this password for Rohan
generateHash("Sneha@123");  // <-- hash this password for Rohan
generateHash("Vikram@123");  // <-- hash this password for Rohan
