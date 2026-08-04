const axios = require("axios");

const GRAPH_URL = `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

const sendOTP = async (phone, otp) => {
    try {
        // const response = await axios.post(
        //   `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
        //   {
        //     messaging_product: "whatsapp",
        //     to: phone,
        //     type: "template",
        //     template: {
        //       name: "login_otp",
        //       language: {
        //         code: "en"
        //       },
        //       components: [
        //         {
        //           type: "body",
        //           parameters: [
        //             {
        //               type: "text",
        //               text: otp
        //             }
        //           ]
        //         }
        //       ]
        //     }
        //   },
        //   {
        //     headers: {
        //       Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        //       "Content-Type": "application/json"
        //     }
        //   }
        // );

        // return response.data;
        console.log("Phone:", phone);
        console.log("OTP:", otp);

        const payload = {
            messaging_product: "whatsapp",
            to: phone,
            type: "template",
            template: {
                name: "login_otp",
                language: {
                    code: "en",
                },
                components: [
                    {
                        type: "body",
                        parameters: [
                            {
                                type: "text",
                                text: otp,
                            },
                        ],
                    },
                    {
                        type: "button",
                        sub_type: "url",
                        index: "0",
                        parameters: [
                            {
                                type: "text",
                                text: otp,
                            },
                        ],
                    },
                ],
            },
        };

        console.log("Payload:", JSON.stringify(payload, null, 2));

        const response = await axios.post(
            `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
            payload,
            {
                headers: {
                    Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                    "Content-Type": "application/json",
                },
            }
        );
    } catch (err) {
        console.log(err.response?.data);
        throw err;
    }
};

async function sendPrescription({

    phone,

    patientName,

    doctorName,

    clinicName,

    prescriptionUrl,

}) {

    try {

        console.log("PHONE_NUMBER_ID:", process.env.WHATSAPP_PHONE_NUMBER_ID);
        console.log(
            "ACCESS_TOKEN:",
            process.env.WHATSAPP_ACCESS_TOKEN?.substring(0, 20) + "..."
        );
        console.log("GRAPH_URL:", GRAPH_URL);
        console.log("Phone:", phone);

        const response = await axios.post(
            GRAPH_URL,
            {
                messaging_product: "whatsapp",
                to: phone,
                type: "template",
                template: {
                    name: "prescription",
                    language: {
                        code: "en"
                    },
                    components: [
                        {
                            type: "body",
                            parameters: [
                                { type: "text", parameter_name: "clinic_name", text: clinicName },
                                { type: "text", parameter_name: "patient_name", text: patientName },
                                { type: "text", parameter_name: "doctor_name", text: doctorName },
                                { type: "text", parameter_name: "prescription_url", text: prescriptionUrl }
                            ]
                        }
                    ]
                }
            },
            {
                headers: {
                    Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
                    "Content-Type": "application/json"
                }
            }
        );

        console.log("Response:", response.data);

        return {

            success: true,

            data: response.data,


        };



    }

    catch (error) {

        console.error("Status:", error.response?.status);

        console.error(
            JSON.stringify(error.response?.data, null, 2)
        );



        return {

            success: false,

            error:

                error.response?.data ||

                error.message

        };

    }

}

module.exports = { sendOTP, sendPrescription };