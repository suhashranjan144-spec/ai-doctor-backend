import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import admin from "firebase-admin";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

/* 🔥 FIREBASE INIT */
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

/* 🔑 GEMINI */
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash";

/* 🧠 NORMALIZE */
const normalize = (t) => t?.toLowerCase().trim();

/* 🧠 SCHEMA VALIDATOR */
function validateSchema(data) {
  return {
    symptoms: Array.isArray(data.symptoms) ? data.symptoms : [],
    medicines: Array.isArray(data.medicines) ? data.medicines : [],
    diet: Array.isArray(data.diet) ? data.diet : [],
    exercise: Array.isArray(data.exercise) ? data.exercise : [],
    precautions: Array.isArray(data.precautions) ? data.precautions : [],
  };
}

/* 🔍 DB SEARCH */
async function searchDoctorUsage(symptoms) {
  let meds = [];

  for (const sym of symptoms) {
    const snap = await db
      .collection("doctor_uses")
      .where("symptom", "==", normalize(sym))
      .orderBy("usage_count", "desc")
      .limit(3)
      .get();

    snap.forEach((doc) => {
      meds.push(doc.data().medicine_name);
    });
  }

  return [...new Set(meds)];
}

/* 💾 LEARNING */
async function updateDoctorUsage(doctor_id, symptoms, medicines) {
  for (const sym of symptoms) {
    for (const med of medicines) {
      const snap = await db
        .collection("doctor_uses")
        .where("doctor_id", "==", doctor_id)
        .where("symptom", "==", normalize(sym))
        .where("medicine_name", "==", normalize(med))
        .get();

      if (!snap.empty) {
        await snap.docs[0].ref.update({
          usage_count: admin.firestore.FieldValue.increment(1),
          last_used: new Date(),
        });
      } else {
        await db.collection("doctor_uses").add({
          doctor_id,
          symptom: normalize(sym),
          medicine_name: normalize(med),
          usage_count: 1,
          created_at: new Date(),
          last_used: new Date(),
        });
      }
    }
  }
}

/* 🤖 GEMINI CALL (STRONG PROMPT) */
async function callGemini(text) {
  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: `
You are a highly intelligent clinical assistant.

Analyze patient symptoms and generate practical treatment advice.

RULES:
- Output STRICT JSON only
- Do NOT leave fields empty
- Make diet/exercise condition-specific (NOT generic)
- Medicines should be realistic

INPUT:
${text}

OUTPUT:
{
  "symptoms": [],
  "medicines": [],
  "diet": [],
  "exercise": [],
  "precautions": []
}
              `,
            },
          ],
        },
      ],
      generationConfig: { temperature: 0.4 },
    }),
  });

  const data = await response.json();

  let aiText =
    data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

  aiText = aiText.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(aiText);
  } catch {
    return {};
  }
}

/* 🚀 ANALYZE */
app.post("/analyze", async (req, res) => {
  try {
    const { text, doctor_id = "default_doc" } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Text required" });
    }

    const aiRaw = await callGemini(text);
    const ai = validateSchema(aiRaw);

    const dbMeds = await searchDoctorUsage(ai.symptoms);

    let finalMedicines =
      dbMeds.length > 0
        ? dbMeds
        : ai.medicines.length > 0
        ? ai.medicines
        : ["Consult doctor"];

    /* 🔥 ALWAYS LEARN */
    await updateDoctorUsage(
      doctor_id,
      ai.symptoms,
      finalMedicines
    );

    return res.json({
      ...ai,
      medicines: finalMedicines,
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* 💾 SAVE */
app.post("/save-prescription", async (req, res) => {
  try {
    const { doctor_id, symptoms, medicines } = req.body;

    await updateDoctorUsage(doctor_id, symptoms, medicines);

    res.json({ success: true });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(process.env.PORT || 3000, () =>
  console.log("🔥 Server running")
);
