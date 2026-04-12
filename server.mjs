import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import admin from "firebase-admin";
import fs from "fs";

dotenv.config();
const app = express();
app.use(cors(), express.json());

// Firebase Initialization
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY || fs.readFileSync("./firebase-key.json", "utf8"));
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash";
const normalize = (t) => t?.toLowerCase().trim();

/* 🔍 SYMPTOM SYNC: Har naya symptom doctor ID ke saath map hoga */
async function syncSymptomKeywords(clinicalTerm, doctor_id) {
    const termId = normalize(clinicalTerm).replace(/\s+/g, '_');
    const symptomRef = db.collection("symptoms_keywords").doc(termId);
    
    await symptomRef.set({
        clinical_term: clinicalTerm,
        last_doctor_id: doctor_id,
        last_updated: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

/* 💎 MEDICINE MASTER SYNC: Agar dawai nayi hai, toh DB mein save karo */
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
        // ✨ AUTO-SAVE: Agar nayi dawai hai, toh master list mein dalo
        const newMed = {
            name: medName,
            name_lowercase: normalize(medName),
            pathy: pathy,
            added_by: doctor_id,
            status: "pending_verification",
            created_at: admin.firestore.FieldValue.serverTimestamp()
        };
        await medRef.set(newMed);
        
        return {
            name: medName,
            potency: "New",
            dosage: "Review Required",
            organ: "Pending",
            is_verified: false
        };
    }
}

/* 🚀 MAIN ANALYZE API */
app.post("/analyze", async (req, res) => {
    try {
        const { text, doctor_id = "default_doc", doctor_pathy = "Allopathy" } = req.body;
        if (!text) return res.status(400).json({ error: "Text required" });

        // 1. Gemini Analysis
        const prompt = `Strict Clinical Analysis. Text: "${text}". Pathy: ${doctor_pathy}. Return ONLY JSON: {"symptoms":[], "medicines":[], "diet":[], "exercise":[], "precautions":[]}. No descriptions in medicine names.`;
        
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.2 }
            }),
        });

        const data = await response.json();
        const aiResponse = JSON.parse(data.candidates[0].content.parts[0].text.replace(/```json|```/g, "").trim());

        // 2. Parallel Processing: Symptoms aur Medicines ko DB se sync karo
        for (let sym of aiResponse.symptoms) {
            await syncSymptomKeywords(sym, doctor_id);
        }

        let enrichedMedicines = [];
        for (let med of aiResponse.medicines) {
            const medData = await getAndSyncMedicine(med, doctor_pathy, doctor_id);
            enrichedMedicines.push(medData);
        }

        // 3. Update AI Learning
        await db.collection("ai_learning").add({
            doctor_id,
            doctor_pathy,
            input_text: text,
            output_json: aiResponse,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({
            ...aiResponse,
            medicines: enrichedMedicines,
            engine: "Zeqvex-Dynamic-Sync-v1"
        });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* 💾 FINAL SAVE: Jab doctor prescription confirm kare */
app.post("/save-prescription", async (req, res) => {
    try {
        const { doctor_id, doctor_pathy, symptoms, medicines } = req.body;
        const batch = db.batch();

        symptoms.forEach(sym => {
            medicines.forEach(med => {
                const medName = typeof med === 'string' ? med : med.name;
                const comboId = Buffer.from(`${normalize(sym)}_${normalize(medName)}_${doctor_pathy}`).toString('base64').substring(0,25);
                const ref = db.collection("doctor_uses").doc(comboId);
                
                batch.set(ref, {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 VIP Engine Synced on Port ${PORT}`));
