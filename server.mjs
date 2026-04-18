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

Understand ANY language input
Return PROFESSIONAL ENGLISH JSON

STRICT:
- JSON ONLY
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

/* 🔥 LEVEL 2: SMART DB SEARCH (RANKING) */
async function searchFromDB(symptoms) {
  let medMap = {};

  for (const sym of symptoms) {
    const snap = await db
      .collection("doctor_uses")
      .where("symptom", "==", normalize(sym))
      .get();

    snap.forEach((doc) => {
      const data = doc.data();
      const med = data.medicine;
      const score = data.usage_count || 1;

      if (!medMap[med]) medMap[med] = 0;
      medMap[med] += score;
    });
  }

  return Object.entries(medMap)
    .sort((a, b) => b[1] - a[1])
    .map((x) => x[0])
    .slice(0, 5);
}

/* 🔥 LEVEL 3: SMART FILTER */
function removeDuplicates(medicines) {
  const seen = new Set();
  const result = [];

  for (const m of medicines) {
    const name = normalize(typeof m === "string" ? m : m.name);

    if (!seen.has(name)) {
      seen.add(name);
      result.push(m);
    }
  }

  return result;
}

/* 💀 LEARNING ENGINE (UPGRADED) */
async function learnEverything(
  doctor_id,
  symptoms,
  medicines,
  aiData,
  finalData,
  source
) {
  const now = new Date();

  const confidence =
    source === "database" ? 0.95 :
    source === "hybrid" ? 0.85 : 0.7;

  // prescriptions
  await db.collection("prescriptions").add({
    doctor_id,
    symptoms,
    medicines,
    ai_used: source !== "database",
    confidence_score: confidence,
    created_at: now,
  });

  // medicine_master
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

  // 🔥 NO DUPLICATE symptoms_keywords
  for (const sym of symptoms) {
    for (const med of medicines) {
      const existing = await db
        .collection("symptoms_keywords")
        .where("symptom", "==", normalize(sym))
        .where("medicine", "==", normalize(med))
        .limit(1)
        .get();

      if (existing.empty) {
        await db.collection("symptoms_keywords").add({
          symptom: normalize(sym),
          medicine: normalize(med),
        });
      }
    }
  }

  // doctor_uses (learning)
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

  // AI learning
  if (source !== "database") {
    await db.collection("ai_learning").add({
      aiData,
      finalData,
      created_at: now,
    });
  }
}

/* 🚀 FINAL ANALYZE */
app.post("/analyze", async (req, res) => {
  try {
    const { text, doctor_id = "auto_doc" } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Text required" });
    }

    // AI
    const aiData = await callGemini(text);
    const symptoms = aiData.symptoms || [];

    // DB
    const dbMeds = await searchFromDB(symptoms);

    let finalData = {};
    let source = "ai";

    // 🔥 HYBRID ENGINE
    if (dbMeds.length > 0) {
      source = "hybrid";

      finalData = {
        ...aiData,
        medicines: [
          ...dbMeds.map((m) => ({ name: m, source: "database" })),
          ...(aiData.medicines || []).map((m) => ({
            ...m,
            source: "ai",
          })),
        ],
      };
    } else {
      finalData = aiData;
    }

    // 🔥 REMOVE DUPLICATES
    finalData.medicines = removeDuplicates(finalData.medicines || []);

    // LEARN
    await learnEverything(
      doctor_id,
      finalData.symptoms || [],
      finalData.medicines.map((m) =>
        typeof m === "string" ? m : m.name
      ),
      aiData,
      finalData,
      source
    );

    // RESPONSE
    res.json({
      source,
      confidence_score:
        source === "database" ? 0.95 :
        source === "hybrid" ? 0.85 : 0.7,
      ...finalData,
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* TEST */
app.get("/", (req, res) => {
  res.send("🔥 AI DOCTOR GOD MODE RUNNING");
});

/* START */
app.listen(process.env.PORT || 3000, () => {
  console.log("🔥 SERVER STARTED");
});
