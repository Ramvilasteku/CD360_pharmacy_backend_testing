const fs = require("fs");
const csv = require("csv-parser");
const db = require("../db");

exports.uploadMedicines = async (req, res) => {

    const results = [];

    fs.createReadStream(req.file.path)
        .pipe(csv())

        .on("data", (row) => {

            results.push([
                row.medicine_name,
                row.amount,
                row.quantity,
                row.when_to_take,
                row.duration,
                row.admin_id
            ]);

        })



        .on("end", async () => {

            try {

                const batchSize = 1000;

                for (let i = 0; i < results.length; i += batchSize) {

                    const batch = results.slice(i, i + batchSize);

                    console.log("Batch size:", batch.length);
                    console.log(batch.slice(0, 3));

                    const [result] = await db.query(
                        `INSERT INTO medicines
                        (medicine_name, amount, quantity, when_to_take, duration, admin_id)
                        VALUES ?`,
                        [batch]
                    );

                    console.log(result);

                    console.log(
                        `${Math.min(i + batchSize, results.length)} inserted`
                    );

                }

                fs.unlinkSync(req.file.path);

                res.json({
                    success: true,
                    total: results.length
                });

            } catch (err) {

                console.log(err);

                res.status(500).json(err);

            }

        });

}