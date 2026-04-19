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
app.use(express.json());

/* 🔥 FIREBASE */
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

/* 🔐 OTP */
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

/* 🤖 GEMINI */
async function callGemini(text) {
  try {

    const prompt = `
You are a highly advanced clinical AI assistant.

Understand patient input in ANY language (Hindi, Gujarati, English, Hinglish, etc.)
But ALWAYS respond in PROFESSIONAL MEDICAL ENGLISH.

STRICT RULES:
- Output MUST be VALID JSON ONLY (no extra text)
- Maintain DOCTOR-LEVEL professionalism
- Medicines must be SAFE and commonly used
- Support multi-pathy (Allopathy, Homeopathy, Ayurveda, Electrohomeopathy)

ANALYZE AND RETURN:

{
  "language_detected": "",
  "symptoms": [],
  "diagnosis": "",
  "possible_conditions": [],
  "medicines": [
    {
      "name": "",
      "type": "allopathy/homeopathy/ayurveda/electrohomeopathy",
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

IMPORTANT:
- Extract symptoms clearly
- Give realistic diagnosis (not fantasy)
- Add proper dosage (e.g. 500mg twice daily)
- Diet should be practical (Indian context)
- Exercise should match condition
- Precautions must be actionable
- If serious → mark severity "critical" and add red_flags

PATIENT INPUT:
${text}
`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2 },
        }),
      }
    );

    const data = await res.json();

    let txt = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    // 🔥 CLEAN RESPONSE
    txt = txt.replace(/```json|```/g, "").trim();

    // 🔥 SAFE PARSE (IMPORTANT)
    try {
      return JSON.parse(txt);
    } catch (parseError) {
      console.log("JSON PARSE FAIL:", txt);

      return {
        language_detected: "unknown",
        symptoms: [],
        diagnosis: "Unable to analyze",
        possible_conditions: [],
        medicines: [],
        diet: [],
        exercise: [],
        precautions: [],
        severity: "unknown",
        risks: [],
        red_flags: []
      };
    }

  } catch (err) {
    console.log("GEMINI ERROR:", err.message);

    return {
      language_detected: "unknown",
      symptoms: [],
      diagnosis: "System error",
      possible_conditions: [],
      medicines: [],
      diet: [],
      exercise: [],
      precautions: [],
      severity: "unknown",
      risks: [],
      red_flags: []
    };
  }
}

/* 🔥 DB BRAIN (3 COLLECTION LOGIC) */
async function dbBrain(symptoms) {
  let medMap = {};

  for (const sym of symptoms) {
    // doctor_uses
    const snap1 = await db.collection("doctor_uses")
      .where("symptom", "==", normalize(sym))
      .get();

    snap1.forEach(d => {
      const data = d.data();
      medMap[data.medicine] = (medMap[data.medicine] || 0) + (data.usage_count || 1);
    });

    // symptoms_keywords
    const snap2 = await db.collection("symptoms_keywords")
      .where("symptom", "==", normalize(sym))
      .get();

    snap2.forEach(d => {
      const data = d.data();
      medMap[data.medicine] = (medMap[data.medicine] || 0) + 2;
    });
  }

  return Object.entries(medMap)
    .sort((a, b) => b[1] - a[1])
    .map(x => x[0])
    .slice(0, 5);
}

/* 🧬 CLINICAL RULE ENGINE */
function clinicalEngine(data) {
  const redFlags = [];

  const text = JSON.stringify(data).toLowerCase();
if (text.includes("chest pain")) redFlags.push("cardiac risk");
if (text.includes("unconscious")) redFlags.push("emergency");
if (text.includes("blood")) redFlags.push("internal bleeding");

// safety
if (text.includes("pregnant") && text.includes("ibuprofen")) {
  redFlags.push("avoid ibuprofen in pregnancy");
}

if (text.includes("asthma") && text.includes("beta blocker")) {
  redFlags.push("beta blockers risk in asthma");

}  

let severity = "mild";
  if (redFlags.length > 0) severity = "critical";

  return {
    ...data,
    severity,
    red_flags: redFlags,
  };
}

/* 🔥 REMOVE DUP */
function removeDup(meds) {
  const set = new Set();
  return meds.filter(m => {
    const name = normalize(typeof m === "string" ? m : m.name);
    if (set.has(name)) return false;
    set.add(name);
    return true;
  });
}

/* 🧬 LEARNING ENGINE */
async function learningEngine(symptoms, medicines) {

  for (const sym of symptoms) {
    for (const med of medicines) {
        

      const ref = db.collection("doctor_uses")
  .doc(`${normalize(sym)}_${normalize(med)}`);

const docSnap = await ref.get();

if (docSnap.exists) {
  await ref.update({
    usage_count: FieldValue.increment(1)
  });
} else {
  await ref.set({
    symptom: normalize(sym),
    medicine: normalize(med),
    usage_count: 1
  });
}
      // symptoms_keywords
    // 🔥 symptoms_keywords (SMART VERSION)

const symRef = db.collection("symptoms_keywords")
  .doc(`${normalize(sym)}_${normalize(med)}`);

const symSnap = await symRef.get();

if (symSnap.exists) {
  await symRef.update({
    count: FieldValue.increment(1)
  });
} 
else {
  await symRef.set({
    symptom: normalize(sym),
    medicine: normalize(med),
    count: 1
  });
}

      // medicine_master
      const exist = await db.collection("medicine_master")
        .where("name", "==", normalize(med))
        .get();

      if (exist.empty) {
        await db.collection("medicine_master").add({
          name: normalize(med),
        });
      }
    }
  }

  // ✅ YAHAN ADD KARNA HAI (END ME)
  await db.collection("ai_learning").add({
    symptoms,
    medicines,
    created_at: new Date()
  });
}/* 🔥 HISTORY */
async function getHistory(patient_id) {
  const snap = await db.collection("prescriptions")
    .where("patient_id", "==", patient_id)
    .limit(5)
    .get();

  let arr = [];
  snap.forEach(d => arr.push(d.data()));
  return arr;
}

/* 🚀 ANALYZE */
app.post("/analyze", async (req, res) => {
  try {
    const { text, patient_id = uuidv4() } = req.body;
// 🧠 STEP 1: basic symptom extraction (simple split या raw input)
const symptoms = text.toLowerCase().split(/,|\s+/);// basic (later improve)

// 🧠 STEP 2: DB FIRST
const dbMeds = await dbBrain(symptoms);

let final;
let source = "db";

// 🧠 STEP 3: DECISION
if (dbMeds.length > 0) {
  // ✅ DB HIT
  final = {
    symptoms,
    diagnosis: "Based on previous clinical records",
    medicines: dbMeds.map(m => ({
      name: m,
      source: "db",
      confidence: 0.95
    })),
    diet: [],
    exercise: [],
    precautions: [],
    severity: "mild",
    risks: [],
    red_flags: []
  };
} else {
  // 🤖 AI FALLBACK
  const aiData = await callGemini(text);

  final = {
    ...aiData,
    medicines: (aiData.medicines || []).map(m => ({
      ...m,
      source: "ai",
      confidence: 0.7
    }))
  };

  source = "ai";
}

// 🧹 CLEANUP + CLINICAL LOGIC
final.medicines = removeDup(final.medicines || []);
final = clinicalEngine(final);
final.doctor_approval_required = final.severity === "critical";

// 🧠 LEARNING (IMPORTANT)
await learningEngine(
  symptoms,
  final.medicines.map(m => typeof m === "string" ? m : m.name)
);
    

    const prescription_id = uuidv4();
const otp = generateOTP();
const otp_expiry = Date.now() + 5 * 60 * 1000; // 5 min

await db.collection("prescriptions").doc(prescription_id).set({
  patient_id,
  otp,
  otp_expiry,
  data: final,
  created_at: new Date()
});

// 🔥 TEST SMS (console)
console.log("OTP SEND:", otp);
    const qr = await QRCode.toDataURL(JSON.stringify({
      patient_id,
      prescription_id
    }));

    res.json({
      success: true,
      source,
      patient_id,
      prescription_id,
      otp,
      qr,
      data: final
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* 🔐 VERIFY */
app.post("/verify", async (req, res) => {
  const { prescription_id, otp } = req.body;

  const doc = await db.collection("prescriptions").doc(prescription_id).get();
  if (!doc.exists) return res.status(404).json({ error: "not found" });

  const data = doc.data();
  if (data.otp !== otp) {
  return res.status(401).json({ error: "wrong otp" });
}

if (Date.now() > data.otp_expiry) {
  return res.status(401).json({ error: "otp expired" });
}
  const history = await getHistory(data.patient_id);

  res.json({
    success: true,
    current: data.data,
    history
  });
});

/* TEST */
app.get("/", (req, res) => {
  res.send("🔥 REAL ZEQVEX CORE RUNNING");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 SERVER LIVE");
});
