/*
====================================================================
services/pdf/clientFallback.js

WHY THIS EXISTS (this one is easy to miss and breaks page 1 silently)

form.controller.js -> submitForm() moves identity fields OUT of the
submitted data and INTO the clients table for registration forms:

    const { result: clientData, consumedKeys } = extractClientFields(data);
    ...
    consumedKeys.forEach(key => delete data[key]);

So for every registration submission, form_data has NO full_name, phone,
email, address, gender or dob — but forms.form_schema still defines those
fields. Rendering straight from form_data leaves the whole Patient
Registration section blank.

This module rebuilds those values from the joined clients row, under
every alias the form builder might have used, and the resolver consults
it only after form_data comes up empty. The alias table is deliberately
a copy of CLIENT_FIELD_ALIASES in form.controller.js — keep the two in
sync (or export one from a shared module and require it in both).
====================================================================
*/

const CLIENT_FIELD_ALIASES = {
    name: ["name", "full_name", "client_name", "patient_name", "participant_name"],
    email: ["email", "email_address"],
    mobile: ["mobile", "contact_number", "phone", "phone_number", "mobile_number", "phone_mobile"],
    address: ["address", "client_address", "home_address"],
    gender: ["gender"],
    dob: ["dob", "date_of_birth", "birth_date"],
    blood_group: ["blood_group", "bloodgroup", "blood_type"]
};

/**
 * @param {object} submission row with client_* columns from the SELECT
 * @returns {object} flat alias -> value map, empty values dropped
 */
function buildClientFallback(submission = {}) {
    const source = {
        name: submission.client_name,
        email: submission.client_email ?? submission.email,
        mobile: submission.client_mobile ?? submission.mobile,
        address: submission.client_address,
        gender: submission.client_gender,
        dob: submission.client_dob,
        blood_group: submission.client_blood_group
    };

    const out = {};

    Object.entries(CLIENT_FIELD_ALIASES).forEach(([column, aliases]) => {
        const value = source[column];
        if (value === undefined || value === null || value === "") return;

        const printable = value instanceof Date
            ? value.toISOString().slice(0, 10)
            : value;

        aliases.forEach((alias) => {
            out[alias] = printable;
        });
    });

    return out;
}

module.exports = { buildClientFallback, CLIENT_FIELD_ALIASES };