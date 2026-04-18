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
const FieldValue = admin.firestore.FieldValue;

/* 🔑 GEMINI */
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash";

/* 🧠 NORMALIZE */
const normalize = (t) => t?.toLowerCase().trim();

/* 🤖 GEMINI CALL */
async function callGemini(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: `
You are a multi-pathy clinical assistant.

Understand ANY language input (Hindi, Hinglish, English etc)
Return PROFESSIONAL ENGLISH medical output.

STRICT RULES:
- JSON ONLY
- No empty fields
- Safe medicines only

INPUT:
${text}

OUTPUT:
{
  "language_detected": "",
  "symptoms": [],
  "diagnosis": "",
  "medicines": [
    {
      "name": "",
      "type": "",
      "dosage": "",
      "duration": ""
    }
  ],
  "diet": [],
  "exercise": [],
  "precautions": []
}
              `,
            },
          ],
        },
      ],
      generationConfig: { temperature: 0.3 },
    }),
  });

  const data = await res.json();

  let txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  txt = txt.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(txt);
  } catch {
    return {};
  }
}

/* 🔍 DB SEARCH */
async function searchFromDB(symptoms) {
  let meds = [];

  for (const sym of symptoms) {
    const snap = await db
      .collection("symptoms_keywords")
      .where("symptom", "==", normalize(sym))
      .limit(3)
      .get();

    snap.forEach((doc) => {
      meds.push(doc.data().medicine);
    });
  }

  return [...new Set(meds)];
}

/* 💀 LEARNING ENGINE */
async function learnEverything(
  doctor_id,
  symptoms,
  medicines,
  aiData,
  finalData,
  source
) {
  const now = new Date();

  // 🧠 confidence logic
  const confidence = source === "database" ? 0.9 : 0.7;

  // 1. prescriptions
  await db.collection("prescriptions").add({
    doctor_id,
    symptoms,
    medicines,
    ai_used: source === "ai",
    confidence_score: confidence,
    created_at: now,
  });

  // 2. medicine_master (no duplicate basic check)
  for (const med of medicines) {
    const existing = await db
      .collection("medicine_master")
      .where("name", "==", normalize(med))
      .limit(1)
      .get();

    if (existing.empty) {
      await db.collection("medicine_master").add({
        name: normalize(med),
        created_at: now,
      });
    }
  }

  // 3. symptoms_keywords
  for (const sym of symptoms) {
    for (const med of medicines) {
      await db.collection("symptoms_keywords").add({
        symptom: normalize(sym),
        medicine: normalize(med),
      });
    }
  }

  // 4. doctor_uses
  for (const sym of symptoms) {
    for (const med of medicines) {
      await db.collection("doctor_uses").add({
        doctor_id,
        symptom: normalize(sym),
        medicine: normalize(med),
        usage_count: FieldValue.increment(1),
        last_used: now,
      });
    }
  }

  // 5. ai_learning (only if AI used)
  if (source === "ai") {
    await db.collection("ai_learning").add({
      aiData,
      finalData,
      created_at: now,
    });
  }
}

/* 🚀 FINAL ANALYZE (AUTO EVERYTHING) */
app.post("/analyze", async (req, res) => {
  try {
    const { text, doctor_id = "auto_doc" } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Text required" });
    }

    // 1. AI call
    const aiData = await callGemini(text);
    const symptoms = aiData.symptoms || [];

    // 2. DB search
    const dbMeds = await searchFromDB(symptoms);

    let finalData = {};
    let source = "ai";

    if (dbMeds.length > 0) {
      source = "database";

      finalData = {
        symptoms,
        medicines: dbMeds,
      };
    } else {
      finalData = aiData;
    }

    // 🔥 AUTO LEARNING
    await learnEverything(
      doctor_id,
      finalData.symptoms || [],
      (finalData.medicines || []).map((m) =>
        typeof m === "string" ? m : m.name
      ),
      aiData,
      finalData,
      source
    );

    // ✅ FINAL RESPONSE
    res.json({
      source,
      confidence_score: source === "database" ? 0.9 : 0.7,
      ...finalData,
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* 🧪 TEST */
app.get("/", (req, res) => {
  res.send("🔥 AI Doctor Backend Running FINAL");
});

/* 🚀 START */
app.listen(process.env.PORT || 3000, () => {
  console.log("🔥 FINAL SERVER RUNNING");
});
