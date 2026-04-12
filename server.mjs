import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import admin from "firebase-admin";
import fs from "fs";

dotenv.config();
const app = express();
app.use(cors(), express.json());

// Firebase Initialization (Supports both Env and Local File)
let serviceAccount;
if (process.env.FIREBASE_KEY) {
    serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
} else {
    serviceAccount = JSON.parse(fs.readFileSync("./firebase-key.json", "utf8"));
}

if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-1.5-flash"; // Using 1.5 Flash for stability
const normalize = (t) => t?.toLowerCase().trim();

/* 🔍 LOGIC 1: SYMPTOM SYNC (Maps to Doctor ID) */
async function syncSymptomKeywords(clinicalTerm, doctor_id) {
    const termId = normalize(clinicalTerm).replace(/\s+/g, '_');
    const symptomRef = db.collection("symptoms_keywords").doc(termId);
    await symptomRef.set({
        clinical_term: clinicalTerm,
        last_doctor_id: doctor_id,
        last_updated: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

/* 🔍 LOGIC 2: MEDICINE MASTER (Fetch or Auto-Create) */
async function getAndSyncMedicine(medName, pathy, doctor_id) {
    const medId = normalize(medName).replace(/\s+/g, '_');
    const medRef = db.collection("medicines_master").doc(`${medId}_${pathy}`);
    const doc = await medRef.get();

    if (doc.exists) {
        const data = doc.data();
        return {
            name: medName,
            potency: data.potency ? data.potency[0] : "Q",
            dosage: data.common_dose || "As directed",
            organ: data.organ || "General",
            is_verified: true
        };
    } else {
        // ✨ Nayi dawai ko Master DB mein dalo
        await medRef.set({
            name: medName,
            name_lowercase: normalize(medName),
            pathy: pathy,
            added_by: doctor_id,
            status: "new_entry",
            created_at: admin.firestore.FieldValue.serverTimestamp()
        });
        return { name: medName, potency: "New", dosage: "Review Needed", is_verified: false };
    }
}

/* 🚀 API: ANALYZE (The Brain) */
app.post("/analyze", async (req, res) => {
    try {
        const { text, doctor_id = "default_doc", doctor_pathy = "Allopathy" } = req.body;
        if (!text) return res.status(400).json({ error: "No text provided" });

        const prompt = `Analyze: "${text}". Pathy: ${doctor_pathy}. Return ONLY JSON: {"symptoms":[], "medicines":[], "diet":[], "exercise":[], "precautions":[]}. No markdown.`;
        
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });

        const data = await response.json();
        const aiResponse = JSON.parse(data.candidates[0].content.parts[0].text.replace(/```json|```/g, "").trim());

        // Process Symptoms & Medicines in parallel
        const symptomPromises = aiResponse.symptoms.map(sym => syncSymptomKeywords(sym, doctor_id));
        const medicinePromises = aiResponse.medicines.map(med => getAndSyncMedicine(med, doctor_pathy, doctor_id));

        await Promise.all([...symptomPromises]);
        const enrichedMeds = await Promise.all(medicinePromises);

        // Save to AI Learning
        await db.collection("ai_learning").add({
            doctor_id, doctor_pathy, input_text: text, output: aiResponse,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ ...aiResponse, medicines: enrichedMeds, engine: "Zeqvex-Vip-Final" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

/* 🚀 API: SAVE (Doctor's Confirmation) */
app.post("/save-prescription", async (req, res) => {
    try {
        const { doctor_id, doctor_pathy, symptoms, medicines } = req.body;
        const batch = db.batch();
        symptoms.forEach(sym => {
            medicines.forEach(med => {
                const medName = typeof med === 'string' ? med : med.name;
                const comboId = Buffer.from(`${normalize(sym)}_${normalize(medName)}_${doctor_pathy}`).toString('base64').substring(0,25);
                batch.set(db.collection("doctor_uses").doc(comboId), {
                    doctor_id, doctor_pathy,
                    symptom: normalize(sym),
                    medicine_name: normalize(medName),
                    usage_count: admin.firestore.FieldValue.increment(1),
                    last_used: admin.firestore.FieldValue.serverTimestamp()
                }, { merge: true });
            });
        });
        await batch.commit();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🔥 VIP Engine Permanent Live`));
