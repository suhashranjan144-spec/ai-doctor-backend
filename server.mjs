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
app.use(express.json({ limit: '50mb' }));

/* 🔥 FIREBASE INIT */
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
    });
}
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

/* 🔑 GEMINI CONFIG */
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash";

/* 🧠 UTILS */
const normalize = (t) => t?.toLowerCase().trim();
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

/* 🧬 MEDICINE TYPE DETECTOR */
function detectType(med) {
    const m = med.toLowerCase();
    if (["paracetamol", "ibuprofen", "amoxicillin", "cetirizine"].some(key => m.includes(key))) return "allopathy";
    if (["belladonna", "arnica", "nux vomica", "s1", "c5", "f1"].some(key => m.includes(key))) return "homeopathy";
    return "unknown";
}

/* 🤖 GEMINI CALLER */
async function callGemini(text) {
    try {
        const prompt = `
You are a highly advanced clinical AI assistant.
Understand patient input in ANY language but respond in PROFESSIONAL MEDICAL ENGLISH.
STRICT RULES: Output VALID JSON ONLY.

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

PATIENT INPUT: ${text}`;

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
        txt = txt.replace(/```json|```/g, "").trim();

        try {
            return JSON.parse(txt);
        } catch (e) {
            return { diagnosis: "Unable to analyze", medicines: [] };
        }
    } catch (err) {
        return { diagnosis: "System error", medicines: [] };
    }
}

/* 🔥 DB BRAIN (Check Collections) */
async function dbBrain(symptoms) {
    let medMap = {};
    for (const sym of symptoms) {
        const normSym = normalize(sym);
        if(!normSym) continue;

        const snap1 = await db.collection("doctor_uses").where("symptom", "==", normSym).get();
        snap1.forEach(d => {
            const data = d.data();
            medMap[data.medicine] = (medMap[data.medicine] || 0) + (data.usage_count || 1);
        });

        const snap2 = await db.collection("symptoms_keywords").where("symptom", "==", normSym).get();
        snap2.forEach(d => {
            const data = d.data();
            medMap[data.medicine] = (medMap[data.medicine] || 0) + 2;
        });
    }

    let result = [];
    for (let [med, score] of Object.entries(medMap)) {
        const snap = await db.collection("medicine_master").where("name", "==", med).limit(1).get();
        let type = snap.empty ? detectType(med) : (snap.docs[0].data().type || "unknown");
        result.push({ name: med, type, score });
    }
    return result.sort((a, b) => b.score - a.score).slice(0, 5);
}

/* 🧬 CLINICAL RULE ENGINE */
function clinicalEngine(data) {
    const redFlags = [];
    const text = JSON.stringify(data).toLowerCase();
    if (text.includes("chest pain")) redFlags.push("cardiac risk");
    if (text.includes("unconscious")) redFlags.push("emergency");
    if (text.includes("blood")) redFlags.push("internal bleeding");

    let severity = redFlags.length > 0 ? "critical" : (data.severity || "mild");
    return { ...data, severity, red_flags: [...new Set([...(data.red_flags || []), ...redFlags])] };
}

/* 🧹 REMOVE DUPLICATES */
function removeDup(meds) {
    const set = new Set();
    return meds.filter(m => {
        const name = normalize(typeof m === "string" ? m : m.name);
        if (!name || set.has(name)) return false;
        set.add(name);
        return true;
    });
}

/* 🧠 LEARNING ENGINE */
async function learningEngine(symptoms, medicines) {
    for (const sym of symptoms) {
        const normSym = normalize(sym);
        if(!normSym) continue;

        for (const med of medicines) {
            const normMed = normalize(med);
            if(!normMed) continue;

            const ref = db.collection("doctor_uses").doc(`${normSym}_${normMed}`);
            const docSnap = await ref.get();
            if (docSnap.exists) {
                await ref.update({ usage_count: FieldValue.increment(1) });
            } else {
                await ref.set({ symptom: normSym, medicine: normMed, usage_count: 1 });
            }

            const symRef = db.collection("symptoms_keywords").doc(`${normSym}_${normMed}`);
            const symSnap = await symRef.get();
            if (symSnap.exists) {
                await symRef.update({ count: FieldValue.increment(1) });
            } else {
                await symRef.set({ symptom: normSym, medicine: normMed, count: 1 });
            }

            const medMasterSnap = await db.collection("medicine_master").where("name", "==", normMed).get();
            if (medMasterSnap.empty) {
                await db.collection("medicine_master").add({
                    name: normMed,
                    type: detectType(normMed),
                    created_at: new Date()
                });
            }
        }
    }
    await db.collection("ai_learning").add({ symptoms, medicines, created_at: new Date() });
}

/* 🔥 HISTORY RETRIEVAL */
async function getHistory(patient_id) {
    const snap = await db.collection("prescriptions")
        .where("patient_id", "==", patient_id)
        .orderBy("created_at", "desc")
        .limit(5)
        .get();
    let arr = [];
    snap.forEach(d => arr.push(d.data()));
    return arr;
}

/* 🚀 ANALYZE ENDPOINT */
app.post("/analyze", async (req, res) => {
    try {
        const { text, doctor_type = "allopathy", patient_id = uuidv4() } = req.body;
        if (!text) return res.status(400).json({ error: "Input text is required" });

        const symptoms = text.toLowerCase().split(/,|\s+/).filter(s => s.length > 2);
        const dbMeds = await dbBrain(symptoms);

        let final;
        let source = "db";

        if (dbMeds.length > 0) {
            let filteredMeds = dbMeds;
            if (doctor_type === "allopathy") {
                filteredMeds = dbMeds.filter(m => m.type === "allopathy");
            }

            // 💀 MAIN FIX START
            if (filteredMeds.length === 0) {
                const aiData = await callGemini(text);
                let aiMeds = (aiData.medicines || []).map(m => ({
                    ...m,
                    source: "ai",
                    confidence: 0.7
                }));

                if (doctor_type === "allopathy") {
                    aiMeds = aiMeds.filter(m => (m.type || detectType(m.name)) === "allopathy");
                }
                final = { ...aiData, medicines: aiMeds };
                source = "ai";
            } else {
                final = {
                    symptoms,
                    diagnosis: "Based on previous clinical records",
                    medicines: filteredMeds.map(m => ({
                        name: m.name,
                        type: m.type,
                        source: "db",
                        confidence: 0.95
                    })),
                    severity: "mild",
                    red_flags: []
                };
            }
            // 💀 MAIN FIX END
        } else {
            const aiData = await callGemini(text);
            let aiMeds = (aiData.medicines || []).map(m => ({
                ...m,
                source: "ai",
                confidence: 0.7
            }));

            if (doctor_type === "allopathy") {
                aiMeds = aiMeds.filter(m => (m.type || detectType(m.name)) === "allopathy");
            }

            final = { ...aiData, medicines: aiMeds };
            source = "ai";
        }

        final.medicines = removeDup(final.medicines || []);
        final = clinicalEngine(final);
        final.doctor_approval_required = final.severity === "critical";

        await learningEngine(symptoms, final.medicines.map(m => m.name));

        const prescription_id = uuidv4();
        const otp = generateOTP();
        const otp_expiry = Date.now() + 5 * 60 * 1000;

        await db.collection("prescriptions").doc(prescription_id).set({
            patient_id,
            otp,
            otp_expiry,
            data: final,
            created_at: new Date()
        });

        const qr = await QRCode.toDataURL(JSON.stringify({ patient_id, prescription_id }));

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
        console.error("Analyze Error:", e);
        res.status(500).json({ error: e.message });
    }
});

/* 🔐 VERIFY ENDPOINT */
app.post("/verify", async (req, res) => {
    try {
        const { prescription_id, otp } = req.body;
        const doc = await db.collection("prescriptions").doc(prescription_id).get();
        if (!doc.exists) return res.status(404).json({ error: "Prescription not found" });
        const data = doc.data();
        if (data.otp !== otp) return res.status(401).json({ error: "Invalid OTP" });
        if (Date.now() > data.otp_expiry) return res.status(401).json({ error: "OTP expired" });
        const history = await getHistory(data.patient_id);
        res.json({ success: true, current: data.data, history });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/", (req, res) => res.send("🔥 REAL ZEQVEX CORE RUNNING"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 SERVER LIVE ON PORT ${PORT}`));
