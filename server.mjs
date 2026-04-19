import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import admin from "firebase-admin";
import QRCode from "qrcode";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

/* 🔥 FIREBASE INIT */
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;


// 🔥 MASTER MEDICINE TEMPLATE (👉 YAHI DALNA HAI)
function createMedicineDoc(name, pathy) {
  const norm = name.toLowerCase();

  return {
    name: name,
    name_lowercase: norm,

    pathy: pathy || "unknown",

    category: "general",

    treats: [],
    search_keywords: [norm],

    organ: [],

    combination_with: [],

    common_dose: "",
    default_times: [],
    duration_days: 0,
    frequency: 0,

    severity_support: ["low", "medium"],

    contraindications: [],

    side_effects: [],

    priority_score: 1,

    verified: false,

    created_at: new Date(),
  };
}

/* 🧠 UTILS */
const normalize = (t) => t?.toLowerCase().trim();


const generateOTP = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

/* 🧬 MEDICINE TYPE DETECTOR */
function detectType(med) {
  const m = med.toLowerCase();

  if (
    m.includes("paracetamol") ||
    m.includes("ibuprofen") ||
    m.includes("amoxicillin") ||
    m.includes("ors") ||
    m.includes("oral rehydration")
  )
    return "allopathy";

  if (m.includes("belladonna") || m.includes("arnica"))
    return "homeopathy";

  return "unknown";
}

/* 🤖 GEMINI CALLER */
async function callGemini(text, doctor_type, mode = "clinical") {
  try {

const clinicalPrompt = `

You are a highly advanced clinical AI assistant.

Understand patient input in ANY language (Hindi, Gujarati, Marathi, Hinglish, etc.) but respond in PROFESSIONAL MEDICAL ENGLISH.

-------------------------------
⚠️ STRICT SYSTEM RULES
-------------------------------
- Output ONLY VALID JSON
- No explanation, no extra text
- DO NOT change structure
- DO NOT skip fields
- DO NOT return null values
- Always fill arrays (even if empty [])

-------------------------------
🧠 CLINICAL BEHAVIOR RULES
-------------------------------
- Extract clear, short symptoms (1–2 words)
- Provide realistic diagnosis (not random)
- Prefer clinically safe suggestions
- Avoid unnecessary medicines
- Add precautions if risk present

-------------------------------
💊 DOCTOR TYPE RULES
-------------------------------
1. allopathy:
   - Only allopathy medicines

2. homeopathy:
   - Prefer homeopathy
   - Allopathy allowed as secondary

3. ayurveda:
   - Prefer ayurveda
   - Allopathy allowed as secondary

4. electrohomeopathy:
   - STRICT electrohomeopathy medicines (S, WE, C, etc.)
   - Allopathy allowed as secondary

5. unani:
   - Prefer unani
   - Allopathy allowed as secondary

-------------------------------
📦 OUTPUT FORMAT (STRICT JSON)
-------------------------------
{
  "language_detected": "",
  "symptoms": [],
  "diagnosis": "",
  "possible_conditions": [],

  "primary_medicines": [
    {
      "name": "",
      "type": "",
      "dosage": "",
      "duration": "",
      "instructions": ""
    }
  ],

  "suggested_medicines": [
    {
      "name": "",
      "type": "",
      "dosage": "",
      "duration": "",
      "instructions": ""
    }
  ],

  "diet": [],
  "exercise": [],
  "precautions": [],
  "severity": "mild/moderate/critical",
  "risks": [],
  "red_flags": []
}

-------------------------------
📥 INPUT
-------------------------------
INPUT: ${text}
DOCTOR TYPE: ${doctor_type}

`;

const prompt = mode === "patient" ? patientPrompt : clinicalPrompt;

    // ✅ ONLY ONE FETCH
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
        process.env.GEMINI_API_KEY,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
          },
        }),
      }
    );

    const data = await response.json();

    let txt =
      data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // cleanup
    txt = txt.replace(/```json|```/g, "").trim();

    const parsed = JSON.parse(txt);

// 🔥 AUTO TYPE FIX (NEW ADD)
parsed.primary_medicines =
  (parsed.primary_medicines || []).map(m => ({
    ...m,
    type: m.type || detectType(m.name)
  }));

parsed.suggested_medicines =
  (parsed.suggested_medicines || []).map(m => ({
    ...m,
    type: m.type || detectType(m.name)
  }));

// 🔥 SAFETY FILTER (already hai)
if (doctor_type === "allopathy") {
  parsed.primary_medicines =
    (parsed.primary_medicines || []).filter(
      (m) => (m.type || detectType(m.name)) === "allopathy"
    );

  parsed.suggested_medicines = [];
}
    

    return parsed;
  } catch (err) {
    return {
      diagnosis: "AI error",
      primary_medicines: [],
      suggested_medicines: [],
    };
  }
}

/* 🔥 DB BRAIN */
async function dbBrain(symptoms) {
  let medMap = {};
const symptomCount = symptoms.length;

  for (const sym of symptoms) {
    const normSym = normalize(sym);
    if (!normSym) continue;

    const snap1 = await db
      .collection("doctor_uses")
      .where("symptom", "==", normSym)
      .get();

   snap1.forEach((d) => {
  const data = d.data();

  const now = Date.now();
  const lastUsed = data.last_used?.toDate()?.getTime() || 0;

  const recencyBoost =
    (now - lastUsed) < 3 * 24 * 60 * 60 * 1000 ? 2 : 1;

  medMap[data.medicine] =
    (medMap[data.medicine] || 0) +
    (data.usage_count || 1) * 3 * recencyBoost * symptomCount;
});
    const snap2 = await db
      .collection("symptoms_keywords")
      .where("symptom", "==", normSym)
      .get();

    snap2.forEach((d) => {
      const data = d.data();
      medMap[data.medicine] =
        (medMap[data.medicine] || 0) + 2;
    });
  }

  let result = [];

  for (let [med, score] of Object.entries(medMap)) {
    const snap = await db
      .collection("medicines_master")
     .doc(med)
     .get();

   let type = snap.exists
     ? snap.data().pathy || detectType(med)
     : detectType(med);

    result.push({
  name: med,
  type,
  score,
  pathy: type,
confidence: Math.min(1, score / 10)
});
  }

  return result.sort((a, b) => b.score - a.score).slice(0, 5);
}

/* 🧬 CLINICAL ENGINE */
function detectDisease(symptoms) {
  const s = symptoms.join(" ");

  if (s.includes("fever") && s.includes("cough"))
    return "viral infection";

  if (s.includes("loose motion") || s.includes("diarrhea"))
    return "gastroenteritis";

  if (s.includes("worms") || s.includes("itching anus"))
    return "worm infestation";

  return "unknown";
}
function getComboMedicines(disease) {
  const map = {
    "viral infection": ["paracetamol", "ors"],
    "gastroenteritis": ["ors", "metronidazole"],
    "worm infestation": ["vermifugo-1", "we"],
  };

  return map[disease] || [];
}

function clinicalEngine(data) {
  const redFlags = [];
  const text = JSON.stringify(data).toLowerCase();

  if (text.includes("chest pain")) redFlags.push("cardiac risk");
  if (text.includes("unconscious")) redFlags.push("emergency");

  const severity =
    redFlags.length > 0 ? "critical" : data.severity || "mild";

  return {
    ...data,
    severity,
    red_flags: [...new Set([...(data.red_flags || []), ...redFlags])],
  };
}

/* 🧹 REMOVE DUPLICATES */
function removeDup(meds = []) {
  const seen = new Set();

  return meds.filter((m) => {
    const raw = typeof m === "string" ? m : m?.name;
    if (!raw) return false;

    const name = normalize(raw).replace(/\(.*?\)/g, "");

    if (!name || seen.has(name)) return false;
    seen.add(name);

    if (typeof m === "object") m.name = name;

    return true;
  });
}

/* 🧠 LEARNING ENGINE */
async function learningEngine(symptoms, medicines) {
  for (const sym of symptoms) {
    const normSym = normalize(sym);
    if (!normSym) continue;

    for (const med of medicines) {
      const normMed = normalize(med);
      if (!normMed) continue;

      await db
        .collection("doctor_uses")
        .doc(`${normSym}_${normMed}`)
        .set(
          {
            symptom: normSym,
            medicine: normMed,
            usage_count: FieldValue.increment(1),
            last_used: new Date(),
          },
          { merge: true }
        );

      await db
        .collection("symptoms_keywords")
        .doc(`${normSym}_${normMed}`)
        .set(
          {
            symptom: normSym,
            medicine: normMed,
            count: FieldValue.increment(1),
          },
          { merge: true }
        );

        await db
  .collection("medicines_master")
  .doc(normMed)
  .set({
    search_keywords: FieldValue.arrayUnion(normSym, normMed)
  }, { merge: true });


      const snap = await db
        .collection("medicines_master")
        .doc(normMed)
        .get();

       const isTrustedSource = true;
       if (!snap.exists && isTrustedSource) {
  const pathy = detectType(normMed);

  const newMed = createMedicineDoc(normMed, pathy);

  await db
    .collection("medicines_master")
    .doc(normMed)
    .set(newMed, { merge: true });
}
    }
  }
}

/* 🚀 ANALYZE */
app.post("/analyze", async (req, res) => {
  try {
    const { text, doctor_type = "allopathy" } = req.body;

    const symptoms = text
      .toLowerCase()
      .split(/,|\s+/)
      .filter((s) => s.length > 3);

    const dbMeds = await dbBrain(symptoms);
    const disease = detectDisease(symptoms);
    const comboMeds = getComboMedicines(disease);

    let final;
    let source;

    let filteredMeds = dbMeds;

    if (doctor_type === "allopathy") {
      filteredMeds = dbMeds.filter(
        (m) => (m.type || detectType(m.name)) === "allopathy"
      );
    }

    // 🔥 AI ONLY CASE
    if (filteredMeds.length === 0) {
      const aiData = await callGemini(text, doctor_type);

      const dbNames = new Set(
  filteredMeds.map(m => normalize(m.name))
);// ⚠️ FIXED

      final = {
  symptoms: aiData.symptoms || symptoms,
  diagnosis: aiData.diagnosis || "AI result",
  disease,
  combo_medicines: comboMeds,
  ...aiData,
  medicines: [
    ...(aiData.primary_medicines || []),
    ...(aiData.suggested_medicines || [])
  ]
};
      source = "ai";
    }

    // 🔥 HYBRID CASE
    else {
      const aiData = await callGemini(text, doctor_type);

      final = {
        symptoms,
        diagnosis: aiData.diagnosis || "Hybrid result",
        disease,
        combo_medicines: comboMeds,
        medicines: [
          ...(aiData.primary_medicines || []),
          ...filteredMeds.map((m) => ({
            name: m.name,
            type: m.type,
            source: "db",
          })),
          ...(aiData.suggested_medicines || []),
        ],
      };

      source = "hybrid";
    }

    final.medicines = removeDup(final.medicines);
    final = clinicalEngine(final);

    await learningEngine(
      symptoms,
      final.medicines.map((m) => m.name)
    );

    const prescription_id = uuidv4();
    const patient_id = uuidv4();
    const otp = generateOTP();

    await db.collection("prescriptions").doc(prescription_id).set({
      patient_id,
      otp,
      data: final,
      created_at: new Date(),
    });

    const qr = await QRCode.toDataURL(
      JSON.stringify({ patient_id, prescription_id })
    );

    res.json({
      success: true,
      source,
      patient_id,
      prescription_id,
      otp,
      qr,
      data: final,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
/* 🔐 VERIFY */
app.post("/verify", async (req, res) => {
  const { prescription_id, otp } = req.body;

  const doc = await db
    .collection("prescriptions")
    .doc(prescription_id)
    .get();

  if (!doc.exists) return res.json({ error: "Not found" });

  const data = doc.data();

  if (data.otp !== otp)
    return res.json({ error: "Invalid OTP" });

  res.json({ success: true, data: data.data });
});

app.get("/", (req, res) =>
  res.send("🔥 ZEQVEX CORE RUNNING")
);

app.listen(3000, () =>
  console.log("🚀 Server running")
);
