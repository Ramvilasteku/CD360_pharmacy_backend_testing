const axios = require("axios");

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

module.exports = { sendOTP };