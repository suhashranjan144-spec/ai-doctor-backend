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
You are a highly experienced clinical doctor with multi-pathy knowledge:
- Allopathy
- Homeopathy
- Ayurveda
- Electro-homeopathy

Your job:
1. Understand patient input in ANY language (Hindi, English, Hinglish, etc.)
2. Convert it into professional clinical understanding
3. Generate a SAFE and PRACTICAL prescription

IMPORTANT RULES:
- Output STRICT JSON ONLY (no text outside JSON)
- Always respond in ENGLISH (professional medical format)
- Do NOT leave fields empty
- Keep medicines realistic and safe
- Diet and exercise MUST be condition-specific
- Avoid dangerous or restricted drugs

INPUT (patient complaint in any language):
"${text}"

OUTPUT FORMAT:
{
  "language_detected": "",
  "symptoms": [],
  "diagnosis": "",
  "medicines": [
    {
      "name": "",
      "type": "allopathy/homeopathy/ayurveda/electrohomeopathy",
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
      generationConfig: {
        temperature: 0.3,
      },
    }),
  });

  const data = await res.json();

  let txt =
    data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

  txt = txt.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(txt);
  } catch (err) {
    console.log("❌ JSON Parse Error:", txt);
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
