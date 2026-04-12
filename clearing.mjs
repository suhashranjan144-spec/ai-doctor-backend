import admin from "firebase-admin";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

/* 🔑 FIREBASE INIT (Tumhari file se read karega) */
const serviceAccount = JSON.parse(
  fs.readFileSync("./firebase-key.json", "utf8")
);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

async function deepCleanDatabase() {
  console.log("🚀 Zeqvex VIP Cleanup Started (Safe Mode)...");

  const collections = [
    "medicines",
    "medicines_db",
    "ai_learning",
    "doctor_uses",
    "medicines_master",
    "symptoms_keywords",
  ];

  for (const col of collections) {
    console.log(`📡 Scanning ${col}...`);
    const snapshot = await db.collection(col).get();
    const batch = db.batch();
    let deletedCount = 0;

    snapshot.forEach((doc) => {
      const data = doc.data();
      let shouldDelete = false;

      // 1. TESTING DATA (Real field check)
      if (data.doctor_id === "doc123" || data.doctor_id === "default_doc") {
        shouldDelete = true;
      }

      // 2. 🔥 MEDICINES_MASTER (Strict Pehchan)
      if (col === "medicines_master") {
        const hasPotency = data.potency !== undefined && data.potency !== null;
        const hasOrgan = data.organ !== undefined && data.organ !== null;
        const hasName = data.name !== undefined && data.name !== "";

        if (!(hasPotency && hasOrgan && hasName)) {
          shouldDelete = true;
        }
      }

      // 3. 🔥 SYMPTOMS_KEYWORDS (Accuracy Check)
      if (col === "symptoms_keywords") {
        if (
          !data.clinical_term ||
          !data.keywords ||
          data.keywords.length === 0
        ) {
          shouldDelete = true;
        }
      }

      // 4. DOCTOR_USES (Pathy check)
      if (col === "doctor_uses" && !data.doctor_pathy) {
        shouldDelete = true;
      }

      if (shouldDelete) {
        batch.delete(doc.ref);
        deletedCount++;
      }
    });

    if (deletedCount > 0) {
      await batch.commit();
    }
    console.log(`✅ ${col}: Deleted ${deletedCount} invalid records.`);
  }

  console.log("✨ Final Tally: Database is now 100% Professional.");
}

deepCleanDatabase().catch((err) => console.error("❌ CRITICAL ERROR:", err));