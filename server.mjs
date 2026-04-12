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
const MODEL = "gemini-2.5-flash";

const normalize = (t) => t?.toLowerCase().trim();

/* 🔥 GEMINI */
async function callGemini(text, pathy) {
  const prompt = `
You are an expert ${pathy} doctor.

Return STRICT JSON:
{
 "symptoms": [],
 "clinical_terms": [],
 "medicines": [],
 "diet": [],
 "exercise": [],
 "precautions": []
}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: text + "\n" + prompt }] }],
      }),
    }
  );

  const data = await res.json();
  let txt = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  txt = txt.replace(/```json|```/g, "").trim();

  return JSON.parse(txt);
}

/* 🔥 SMART RANK */
function rankResults(ai, dbData) {
  const map = new Map();

  dbData.forEach(item => {
    map.set(item, (map.get(item) || 0) + 5);
  });

  ai.forEach(item => {
    map.set(item, (map.get(item) || 0) + 1);
  });

  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(x => x[0])
    .slice(0, 5);
}

/* 🔥 DB FETCH */

async function getAIlearning(type, symptoms, doctor_pathy) {
  let result = [];

  for (const sym of symptoms) {
    const snap = await db.collection("ai_learning")
      .where("doctor_pathy", "==", doctor_pathy)
      .where("symptom", "==", normalize(sym))
      .where("type", "==", type)
      .orderBy("usage_count", "desc")
      .limit(5)
      .get();

    snap.forEach(d => result.push(d.data().value));
  }

  return [...new Set(result)];
}

async function getMaster(col, symptoms, doctor_pathy) {
  let result = [];

  for (const sym of symptoms) {
    const snap = await db.collection(col)
      .where("doctor_pathy", "==", doctor_pathy)
      .where("symptom", "==", normalize(sym))
      .get();

    snap.forEach(d => result.push(d.data().value));
  }

  return [...new Set(result)];
}

async function saveToMaster(col, items, symptoms, doctor_pathy) {
  const batch = db.batch();

  items.forEach(item => {
    symptoms.forEach(sym => {
      const id = `${doctor_pathy}_${normalize(sym)}_${normalize(item)}`;

      batch.set(db.collection(col).doc(id), {
        doctor_pathy,
        symptom: normalize(sym),
        value: normalize(item),
        source: "ai_generated",
        created_at: new Date()
      }, { merge: true });
    });
  });

  await batch.commit();
}

/* 🔥 ANALYZE */
app.post("/analyze", async (req, res) => {
  try {
    const { text, doctor_pathy = "Allopathy" } = req.body;

    if (!text) return res.status(400).json({ error: "No input" });

    const ai = await callGemini(text, doctor_pathy);
    const symptoms = ai.symptoms || [];

    const process = async (type, masterCol, aiData) => {
      const dbData = await getAIlearning(type, symptoms, doctor_pathy);
      const master = await getMaster(masterCol, symptoms, doctor_pathy);

      let result = rankResults(aiData || [], [...dbData, ...master]);

      if (!result.length) {
        result = aiData || [];
        await saveToMaster(masterCol, result, symptoms, doctor_pathy);
      }

      return result;
    };

    const medicines = await process("medicine", "medicine_master", ai.medicines);
    const diet = await process("diet", "diet_master", ai.diet);
    const exercise = await process("exercise", "exercise_master", ai.exercise);
    const precautions = await process("precautions", "precautions_master", ai.precautions);

    res.json({ symptoms, medicines, diet, exercise, precautions });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* 🔥 SAVE PRESCRIPTION */
app.post("/save-prescription", async (req, res) => {
  try {
    const { doctor_pathy, symptoms, medicines, diet, exercise, precautions } = req.body;

    const batch = db.batch();

    const save = (type, items) => {
      if (!items) return;

      items.forEach(item => {
        symptoms.forEach(sym => {
          const id = `${type}_${doctor_pathy}_${normalize(sym)}_${normalize(item)}`;

          batch.set(db.collection("ai_learning").doc(id), {
            type,
            doctor_pathy,
            symptom: normalize(sym),
            value: normalize(item),
            usage_count: admin.firestore.FieldValue.increment(1),
            updated_at: new Date(),
            source: "doctor_used"
          }, { merge: true });
        });
      });
    };

    save("medicine", medicines);
    save("diet", diet);
    save("exercise", exercise);
    save("precautions", precautions);

    await batch.commit();

    res.json({ success: true });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* 🔥 ANALYTICS */
app.get("/analytics/top", async (req, res) => {
  const snap = await db.collection("ai_learning")
    .orderBy("usage_count", "desc")
    .limit(20)
    .get();

  res.json(snap.docs.map(d => d.data()));
});

app.get("/analytics/symptoms", async (req, res) => {
  const snap = await db.collection("ai_learning").get();

  const map = {};
  snap.forEach(doc => {
    const s = doc.data().symptom;
    map[s] = (map[s] || 0) + 1;
  });

  res.json(Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 20));
});

/* 🔥 ADMIN */
app.delete("/admin/delete", async (req, res) => {
  const { id } = req.body;
  await db.collection("ai_learning").doc(id).delete();
  res.json({ success: true });
});

app.post("/admin/boost", async (req, res) => {
  const { id, boost = 5 } = req.body;

  await db.collection("ai_learning").doc(id).update({
    usage_count: admin.firestore.FieldValue.increment(boost)
  });

  res.json({ success: true });
});

app.listen(10000, () => console.log("🔥 FINAL AI PLATFORM RUNNING"));
