import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import admin from "firebase-admin";
import fs from "fs";

dotenv.config();
const app = express();
app.use(cors(), express.json());

// 🔑 FIREBASE INITIALIZATION
let serviceAccount;
try {
    serviceAccount = process.env.FIREBASE_KEY 
        ? JSON.parse(process.env.FIREBASE_KEY) 
        : JSON.parse(fs.readFileSync("./firebase-key.json", "utf8"));
} catch (err) {
    console.error("❌ Firebase Init Error:", err.message);
}

if (!admin.apps.length && serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash"; // ✅ Fixed to your preferred version
const normalize = (t) => t?.toLowerCase().trim();

/* 🔍 LOGIC 3: SYMPTOMS KEYWORDS (Bhasha Badalne Wali Machine) */
async function syncSymptomKeywords(clinicalTerm, doctor_id) {
    if (!clinicalTerm) return;
    const termId = normalize(clinicalTerm).replace(/\s+/g, '_');
    const symptomRef = db.collection("symptoms_keywords").doc(termId);
    
    // Naye symptoms ko doctor ID ke saath map karna
    await symptomRef.set({
        clinical_term: clinicalTerm,
        last_doctor_id: doctor_id,
        last_updated: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

/* 🔍 LOGIC 1: MEDICINES MASTER (Asli Medical Shop) */
async function getAndSyncMedicine(medName, pathy, doctor_id) {
    if (!medName) return { name: "Unknown", is_verified: false };
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
        // Assistant nayi dawai ko dukan mein add kar raha hai
        await medRef.set({
            name: medName,
            name_lowercase: normalize(medName),
            pathy: pathy,
            added_by: doctor_id,
            status: "new_entry",
            created_at: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return { name: medName, potency: "New", dosage: "Review Needed", is_verified: false };
    }
}

/* 🚀 API: ANALYZE (Assistant ka Kaam) */
app.post("/analyze", async (req, res) => {
    try {
        const { text, doctor_id = "default_doc", doctor_pathy = "Allopathy" } = req.body;
        if (!text) return res.status(400).json({ error: "No text provided" });

        const prompt = `Analyze patient text: "${text}". Pathy: ${doctor_pathy}. Return ONLY STRICT JSON: {"symptoms":[], "medicines":[], "diet":[], "exercise":[], "precautions":[]}. No markdown, no prose.`;
        
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        });

        const data = await response.json();
        
        if (!data.candidates || data.candidates.length === 0) {
            throw new Error("AI response empty or safety triggered");
        }

        let aiText = data.candidates[0].content.parts[0].text.replace(/```json|```/g, "").trim();
        const aiResponse = JSON.parse(aiText);

        // Symptoms sync logic (Order 1)
        for (const sym of aiResponse.symptoms) {
            await syncSymptomKeywords(sym, doctor_id);
        }

        // Medicines master sync logic (Order 2)
        let enrichedMeds = [];
        for (const med of aiResponse.medicines) {
            const detailedMed = await getAndSyncMedicine(med, doctor_pathy, doctor_id);
            enrichedMeds.push(detailedMed);
        }

        /* 🔍 LOGIC 4: AI LEARNING (Assistant ki Report Card) */
        await db.collection("ai_learning").add({
            doctor_id, doctor_pathy, input_text: text, output: aiResponse,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ ...aiResponse, medicines: enrichedMeds, engine: "Zeqvex-Vip-2.5-Final" });

    } catch (e) {
        res.status(500).json({ error: "Analyze Error", details: e.message });
    }
});

/* 🚀 API: SAVE (LOGIC 2: Doctor ka Purana Tajurba) */
app.post("/save-prescription", async (req, res) => {
    try {
        const { doctor_id, doctor_pathy, symptoms, medicines } = req.body;
        const batch = db.batch();
        
        // Doctor ke tajurbe ko dairy (doctor_uses) mein likhna
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
app.listen(PORT, () => console.log(`🚀 VIP Engine 2.5 Live - All Systems Synced`));
