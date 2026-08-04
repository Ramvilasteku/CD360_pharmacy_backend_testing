const fs = require("fs-extra");
const path = require("path");
const { v4: uuid } = require("uuid");
const puppeteer = require("puppeteer");
const buildPrescriptionPDF = require("./buildPrescriptionPdf");

// async function generatePrescriptionPdf(payload) {

//     const {
//         patient,
//         doctor,
//         diagnosis,
//         notes,
//         description,
//         medicines,
//         tests,
//         clinic,
//     } = payload;

//     const today = new Date().toLocaleDateString("en-IN");

//     const medicineRows = (medicines || [])
//         .map((m, i) => {

//             return `
//             <tr>
//                 <td>${i + 1}</td>
//                 <td>${m.medicine_name || ""}</td>
//                 <td>${m.type || ""}</td>
//                 <td>${m.strength || ""}</td>
//                 <td>${m.amount || ""}</td>
//                 <td>${m.when_to_take || ""}</td>
//                 <td>${m.duration || ""}</td>
//             </tr>
//             `;

//         })
//         .join("");



//     const testRows = (tests || [])
//         .map((t, i) => {

//             return `
//             <tr>
//                 <td>${i + 1}</td>
//                 <td>${t.test_name || ""}</td>
//                 <td>${t.test_type || ""}</td>
//                 <td>${t.description || ""}</td>
//             </tr>
//             `;

//         })
//         .join("");



//     const html = `

// <!DOCTYPE html>

// <html>

// <head>

// <meta charset="utf-8">

// <style>

// body{

// font-family:Arial;

// padding:35px;

// color:#333;

// }

// .header{

// background:#009688;

// color:white;

// padding:20px;

// border-radius:8px;

// }

// .section{

// margin-top:20px;

// }

// table{

// width:100%;

// border-collapse:collapse;

// margin-top:10px;

// }

// table th{

// background:#009688;

// color:white;

// padding:8px;

// font-size:13px;

// }

// table td{

// border:1px solid #ddd;

// padding:8px;

// font-size:12px;

// }

// .footer{

// margin-top:40px;

// text-align:center;

// font-size:12px;

// color:#777;

// }

// </style>

// </head>

// <body>

// <div class="header">

// <h1>${clinic.name}</h1>

// <p>${clinic.tagline}</p>

// </div>

// <div class="section">

// <h3>Patient Information</h3>

// <p>

// <b>Patient :</b> ${patient.name}<br>

// <b>Patient ID :</b> ${patient.id}<br>

// <b>Doctor :</b> Dr. ${doctor.name}<br>

// <b>Date :</b> ${today}

// </p>

// </div>

// <div class="section">

// <h3>Diagnosis</h3>

// <p>${diagnosis || "-"}</p>

// </div>

// <div class="section">

// <h3>Medicines</h3>

// <table>

// <tr>

// <th>#</th>

// <th>Name</th>

// <th>Type</th>

// <th>Strength</th>

// <th>Dose</th>

// <th>When</th>

// <th>Duration</th>

// </tr>

// ${medicineRows}

// </table>

// </div>

// <div class="section">

// <h3>Tests</h3>

// <table>

// <tr>

// <th>#</th>

// <th>Test</th>

// <th>Type</th>

// <th>Description</th>

// </tr>

// ${testRows}

// </table>

// </div>

// <div class="section">

// <h3>Notes</h3>

// <p>${notes || "-"}</p>

// </div>

// <div class="section">

// <h3>Instructions</h3>

// <p>${description || "-"}</p>

// </div>

// <div class="footer">

// ${clinic.name}<br>

// ${clinic.address}

// </div>

// </body>

// </html>

// `;



//     const browser = await puppeteer.launch({

//         headless: true,

//         args: [

//             "--no-sandbox",

//             "--disable-setuid-sandbox"

//         ]

//     });



//     const page = await browser.newPage();

//     await page.setContent(html, {

//         waitUntil: "networkidle0"

//     });



//     const tempFolder = path.join(

//         process.cwd(),

//         "temp",

//         "prescriptions"

//     );



//     await fs.ensureDir(tempFolder);



//     const fileName =
// `RX_${Date.now()}.pdf`;



//     const pdfPath = path.join(

//         tempFolder,

//         fileName

//     );



//     await page.pdf({

//         path: pdfPath,

//         format: "A4",

//         printBackground: true,

//         margin: {

//             top: "15mm",

//             bottom: "15mm",

//             left: "12mm",

//             right: "12mm"

//         }

//     });



//     await browser.close();



//     return {

//         fileName,

//         pdfPath

//     };

// }

async function generatePrescriptionPdf(data) {
  // 1. Build the PDF in memory (shared design → single source of truth)
  const pdfBuffer = await buildPrescriptionPDF(data);
 
  // 2. Make sure the output folder exists
  const tempFolder = path.join(process.cwd(), "temp", "prescriptions");
  await fs.ensureDir(tempFolder);
 
  // 3. Unguessable filename — uuid instead of a sequential timestamp,
  //    so prescription URLs can't be enumerated by outsiders.
  const fileName = `RX_${uuid()}.pdf`;
  const pdfPath  = path.join(tempFolder, fileName);
 
  // 4. Write the buffer to disk
  await fs.writeFile(pdfPath, pdfBuffer);
 
  return { fileName, pdfPath };
}



module.exports = generatePrescriptionPdf;