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
STRICT JSON ONLY

Extract:
- symptoms
- medicines
- diet
- exercise
- precautions

INPUT: ${text}

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
    }),
  });

  const data = await res.json();

  let txt =
    data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

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
  finalData
) {
  const now = new Date();

  // 1. prescriptions
  await db.collection("prescriptions").add({
    doctor_id,
    symptoms,
    medicines,
    created_at: now,
  });

  // 2. medicine_master
  for (const med of medicines) {
    await db.collection("medicine_master").add({
      name: normalize(med),
      created_at: now,
    });
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

  // 5. ai_learning
  if (JSON.stringify(aiData) !== JSON.stringify(finalData)) {
    await db.collection("ai_learning").add({
      aiData,
      correctedData: finalData,
      created_at: now,
    });
  }
}

/* 🚀 ANALYZE API */
app.post("/analyze", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Text required" });
    }

    // 1. AI se symptoms
    const aiData = await callGemini(text);
    const symptoms = aiData.symptoms || [];

    // 2. DB check
    const dbMeds = await searchFromDB(symptoms);

    if (dbMeds.length > 0) {
      return res.json({
        source: "database",
        symptoms,
        medicines: dbMeds,
      });
    }

    // 3. AI fallback
    return res.json({
      source: "ai",
      ...aiData,
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* 💾 SAVE API */
app.post("/save", async (req, res) => {
  try {
    const {
      doctor_id = "default_doc",
      symptoms,
      medicines,
      aiData = {},
      finalData = {},
    } = req.body;

    if (!symptoms || !medicines) {
      return res.status(400).json({ error: "Missing data" });
    }

    await learnEverything(
      doctor_id,
      symptoms,
      medicines,
      aiData,
      finalData
    );

    res.json({ success: true });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* 🧪 TEST ROUTE */
app.get("/", (req, res) => {
  res.send("🔥 AI Doctor Backend Running");
});

/* 🚀 START */
app.listen(process.env.PORT || 3000, () => {
  console.log("🔥 Server running");
});
