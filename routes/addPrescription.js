import React, { useState } from "react";
import AddMedicine from "./AddMedicine";
import AddTests from "./AddTests";
import PatientSelector from "./PatientSelector";

function AddPrescription() {
  const [patientId, setPatientId] = useState("");
  const [medicines, setMedicines] = useState([]);
  const [tests, setTests] = useState([]);
  const [notes, setNotes] = useState("");
  const [savedPrescription, setSavedPrescription] = useState(null);

  const savePrescription = async () => {
    const res = await fetch("/api/prescriptions", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        patient_id: patientId,
        medicines,
        tests,
        notes
      })
    });

    const data = await res.json();
    if (data.success) {
      fetch(`/api/prescriptions/${data.prescription_id}`, {
        credentials: "include"
      })
        .then(res => res.json())
        .then(res => setSavedPrescription(res.data));
    }
  };

  return (
    <>
      <PatientSelector onSelect={setPatientId} />

      <AddTests onAdd={(d) => setTests([...tests, d])} />
      <AddMedicine onAdd={(d) => setMedicines([...medicines, d])} />

      <textarea
        placeholder="Doctor notes"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />

      <button onClick={savePrescription}>Save Prescription</button>

      {/* PREVIEW FROM DB */}
      {savedPrescription && (
        <div className="preview-box">
          <h3>Prescription Preview</h3>
          <p><strong>Patient:</strong> {savedPrescription.patient_name}</p>

          <h4>Tests</h4>
          <ul>
            {savedPrescription.tests.map((t, i) => (
              <li key={i}>{t.name} - {t.type}</li>
            ))}
          </ul>

          <h4>Medicines</h4>
          <ul>
            {savedPrescription.medicines.map((m, i) => (
              <li key={i}>
                {m.name} | {m.type} | {m.strength} | {m.duration} days
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

export default AddPrescription;
