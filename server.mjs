import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import admin from "firebase-admin";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

/* 🔥 FIREBASE INIT (FROM ENV) */
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

/* 🔑 GEMINI CONFIG */
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash";

/* 🔥 SEARCH FROM FIREBASE */
async function searchDoctorUsage(symptoms) {
  let medicines = [];

  for (const sym of symptoms) {
    const snapshot = await db
      .collection("doctor_uses")
      .where("symptom", "==", sym.toLowerCase())
      .orderBy("usage_count", "desc")
      .limit(3)
      .get();

    snapshot.forEach((doc) => {
      medicines.push(doc.data().medicine_name);
    });
  }

  return [...new Set(medicines)];
}

/* 🔥 SAVE LEARNING */
async function updateDoctorUsage(doctor_id, symptoms, medicines) {
  for (const sym of symptoms) {
    for (const med of medicines) {
      const snapshot = await db
        .collection("doctor_uses")
        .where("doctor_id", "==", doctor_id)
        .where("symptom", "==", sym.toLowerCase())
        .where("medicine_name", "==", med.toLowerCase())
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
          symptom: sym.toLowerCase(),
          medicine_name: med.toLowerCase(),
          usage_count: 1,
          created_at: new Date(),
          last_used: new Date(),
        });
      }
    }
  }
}

/* 🚀 ANALYZE API */
app.post("/analyze", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Text required" });
    }

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
You are a STRICT JSON medical assistant.

Extract symptoms and medicines.

Text: ${text}

Return ONLY JSON:
{
  "symptoms": [],
  "medicines": []
}
                `,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
        },
      }),
    });

    const data = await response.json();

    let aiText =
      data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    aiText = aiText.replace(/```json|```/g, "").trim();

    let aiResponse;

    try {
      aiResponse = JSON.parse(aiText);
    } catch {
      aiResponse = { symptoms: [], medicines: [] };
    }

    const learnedMedicines = await searchDoctorUsage(
      aiResponse.symptoms || []
    );

    let finalMedicines =
      learnedMedicines.length > 0
        ? learnedMedicines
        : aiResponse.medicines || [];

    return res.json({
      symptoms: aiResponse.symptoms || [],
      medicines: finalMedicines,
    });

  } catch (error) {
    res.status(500).json({
      error: "Server Error",
      msg: error.message,
    });
  }
});

/* 💾 SAVE PRESCRIPTION */
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

/* 🚀 START SERVER */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🔥 Server running on ${PORT}`);
});
