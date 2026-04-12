import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import admin from "firebase-admin";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

/* 🔥 FIREBASE INIT (SAFE) */
let serviceAccount;

try {
  serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} catch (e) {
  console.error("❌ FIREBASE_KEY missing or invalid");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

/* 🔑 GEMINI CONFIG */
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash";

/* 🧠 NORMALIZE TEXT */
function normalize(text) {
  return text?.toLowerCase().trim();
}

/* 🔍 SEARCH FROM DB (SMART) */
async function searchDoctorUsage(symptoms) {
  let medicines = [];

  for (const sym of symptoms) {
    const snapshot = await db
      .collection("doctor_uses")
      .where("symptom", "==", normalize(sym))
      .orderBy("usage_count", "desc")
      .limit(3)
      .get();

    snapshot.forEach((doc) => {
      medicines.push(doc.data().medicine_name);
    });
  }

  return [...new Set(medicines)];
}

/* 💾 LEARNING SYSTEM */
async function updateDoctorUsage(doctor_id, symptoms, medicines) {
  for (const sym of symptoms) {
    for (const med of medicines) {
      const snapshot = await db
        .collection("doctor_uses")
        .where("doctor_id", "==", doctor_id)
        .where("symptom", "==", normalize(sym))
        .where("medicine_name", "==", normalize(med))
        .get();

      if (!snapshot.empty) {
        const doc = snapshot.docs[0];

        await doc.ref.update({
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

/* 🤖 GEMINI CALL */
async function callGemini(text) {
  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: `
You are a STRICT medical assistant.

Analyze text and return ONLY JSON.

Text: ${text}

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
      generationConfig: {
        temperature: 0.3,
      },
    }),
  });

  const data = await response.json();

  let aiText =
    data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

  aiText = aiText.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(aiText);
  } catch {
    return {
      symptoms: [],
      medicines: [],
      diet: [],
      exercise: [],
      precautions: [],
    };
  }
}

/* 🚀 MAIN API */
app.post("/analyze", async (req, res) => {
  try {
    const { text, doctor_id = "default_doc" } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Text required" });
    }

    /* 🤖 STEP 1: GEMINI */
    const ai = await callGemini(text);

    /* 🧠 STEP 2: DB PRIORITY */
    const dbMeds = await searchDoctorUsage(ai.symptoms || []);

    const finalMedicines =
      dbMeds.length > 0 ? dbMeds : ai.medicines || [];

    /* 📈 STEP 3: AUTO LEARNING */
    if (dbMeds.length === 0 && finalMedicines.length > 0) {
      await updateDoctorUsage(
        doctor_id,
        ai.symptoms,
        finalMedicines
      );
    }

    return res.json({
      symptoms: ai.symptoms || [],
      medicines: finalMedicines,
      diet: ai.diet || [],
      exercise: ai.exercise || [],
      precautions: ai.precautions || [],
    });

  } catch (error) {
    res.status(500).json({
      error: "Server Error",
      msg: error.message,
    });
  }
});

/* 💾 SAVE API */
app.post("/save-prescription", async (req, res) => {
  try {
    const { doctor_id, symptoms, medicines } = req.body;

    if (!doctor_id || !symptoms || !medicines) {
      return res.status(400).json({ error: "Missing data" });
    }

    await updateDoctorUsage(doctor_id, symptoms, medicines);

    return res.json({ success: true });

  } catch (error) {
    res.status(500).json({
      error: "Save failed",
      msg: error.message,
    });
  }
});

/* 🚀 START */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🔥 Server running on ${PORT}`);
});