import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import admin from "firebase-admin";
import fs from "fs";

dotenv.config();
const app = express();
app.use(cors(), express.json());

/* 🔥 FIREBASE INIT */
const serviceAccount = process.env.FIREBASE_KEY
  ? JSON.parse(process.env.FIREBASE_KEY)
  : JSON.parse(fs.readFileSync("./firebase-key.json", "utf8"));

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-1.5-flash";

const normalize = (t) => t?.toLowerCase().trim();

/* ===============================
   🔹 GEMINI (ONLY WHEN NEEDED)
================================ */
async function callGemini(text, pathy) {
  const prompt = `
You are an expert ${pathy} doctor.

Patient input:
"${text}"

Return JSON:
{
 "symptoms": [],
 "medicines": [],
 "diet": [],
 "exercise": [],
 "precautions": []
}
`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );

  const data = await res.json();
  const txt = data.candidates[0].content.parts[0].text
    .replace(/```json|```/g, "")
    .trim();

  return JSON.parse(txt);
}

/* ===============================
   🔹 DB HELPERS
================================ */
async function getDoctorData(col, symptoms, doctor_id) {
  let result = [];
  for (const sym of symptoms) {
    const snap = await db.collection(col)
      .where("doctor_id", "==", doctor_id)
      .where("symptom", "==", normalize(sym))
      .get();

    snap.forEach(d => result.push(d.data().value));
  }
  return [...new Set(result)];
}

async function getGlobalData(col, symptoms) {
  let result = [];
  for (const sym of symptoms) {
    const snap = await db.collection(col)
      .where("symptom", "==", normalize(sym))
      .get();

    snap.forEach(d => result.push(d.data().value));
  }
  return [...new Set(result)];
}

/* ===============================
   🔹 SAVE SYMPTOMS
================================ */
async function saveSymptoms(symptoms, doctor_id) {
  for (const s of symptoms) {
    const id = `${doctor_id}_${normalize(s).replace(/\s+/g, "_")}`;
    await db.collection("symptoms_keywords").doc(id).set({
      symptom: normalize(s),
      doctor_id,
    }, { merge: true });
  }
}

/* ===============================
   🔹 MEDICINE MASTER
================================ */
async function getMedicine(name, pathy, doctor_id) {
  const id = normalize(name).replace(/\s+/g, "_");
  const ref = db.collection("medicines_master").doc(`${id}_${pathy}`);
  const doc = await ref.get();

  if (doc.exists) {
    return { name, verified: true };
  }

  await ref.set({
    name,
    added_by: doctor_id,
  });

  return { name, verified: false };
}

/* ===============================
   🚀 ANALYZE
================================ */
app.post("/analyze", async (req, res) => {
  try {
    const { text, doctor_id = "doc1", doctor_pathy = "Allopathy" } = req.body;

    if (!text) return res.status(400).json({ error: "No input" });

    // 🔹 ALWAYS Gemini for symptoms
    const ai = await callGemini(text, doctor_pathy);
    const symptoms = ai.symptoms || [];

    await saveSymptoms(symptoms, doctor_id);

    /* 🔥 MEDICINES */
    let medicines =
      await getDoctorData("doctor_uses", symptoms, doctor_id);

    if (medicines.length === 0)
      medicines = await getGlobalData("doctor_uses", symptoms);

    if (medicines.length === 0)
      medicines = ai.medicines || [];

    /* 🔥 DIET */
    let diet =
      await getDoctorData("doctor_diet", symptoms, doctor_id);

    if (diet.length === 0)
      diet = await getGlobalData("doctor_diet", symptoms);

    if (diet.length === 0)
      diet = ai.diet || [];

    /* 🔥 EXERCISE */
    let exercise =
      await getDoctorData("doctor_exercise", symptoms, doctor_id);

    if (exercise.length === 0)
      exercise = await getGlobalData("doctor_exercise", symptoms);

    if (exercise.length === 0)
      exercise = ai.exercise || [];

    /* 🔥 PRECAUTIONS */
    let precautions =
      await getDoctorData("doctor_precautions", symptoms, doctor_id);

    if (precautions.length === 0)
      precautions = await getGlobalData("doctor_precautions", symptoms);

    if (precautions.length === 0)
      precautions = ai.precautions || [];

    /* 🔹 SAVE NEW MEDICINES */
    let finalMeds = [];
    for (const m of medicines) {
      const med = await getMedicine(m, doctor_pathy, doctor_id);
      finalMeds.push(med);
    }

    res.json({
      symptoms,
      medicines: finalMeds,
      diet,
      exercise,
      precautions,
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ===============================
   💾 SAVE PRESCRIPTION
================================ */
app.post("/save-prescription", async (req, res) => {
  try {
    const { doctor_id, symptoms, medicines, diet, exercise, precautions } = req.body;

    const batch = db.batch();

    const save = (col, value) => {
      symptoms.forEach(sym => {
        const id = `${doctor_id}_${normalize(sym)}_${normalize(value)}`;
        batch.set(db.collection(col).doc(id), {
          doctor_id,
          symptom: normalize(sym),
          value: normalize(value),
        }, { merge: true });
      });
    };

    medicines.forEach(m => save("doctor_uses", m.name || m));
    diet?.forEach(d => save("doctor_diet", d));
    exercise?.forEach(e => save("doctor_exercise", e));
    precautions?.forEach(p => save("doctor_precautions", p));

    await batch.commit();

    res.json({ success: true });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(10000, () => console.log("🔥 Zeqvex Final Engine Running"));
