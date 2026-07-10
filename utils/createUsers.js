const bcrypt = require("bcrypt");
const db = require("../config/db");
require('dotenv').config(); // <-- ADD THIS LINE

async function createUsers(){
    try {
        console.log('🔑 Hashing password...');
        const password = await bcrypt.hash("Fourbrothers@2026", 10);
        console.log('✅ Password hashed');

        const users = [
            ["sports@fourbrothers.online", password, "sports_manager"],
            ["scents@fourbrothers.online", password, "scents_manager"],
            ["manager@fourbrothers.online", password, "super_manager"]
        ];

        console.log('📝 Inserting users...');

        users.forEach((user, index) => {
            db.query(
                "INSERT IGNORE INTO users(email, password, role) VALUES(?, ?, ?)",
                user,
                (err, result) => {
                    if (err) {
                        console.error(`❌ Error inserting ${user[0]}:`, err.message);
                    } else {
                        console.log(`✅ Inserted: ${user[0]}`);
                    }
                    
                    if (index === users.length - 1) {
                        console.log('\n✅ All users created successfully!');
                        console.log('📧 Users:');
                        console.log('   - sports@fourbrothers.online (Sports Manager)');
                        console.log('   - scents@fourbrothers.online (Scents Manager)');
                        console.log('   - manager@fourbrothers.online (Super Manager)');
                        console.log('🔑 Password: Fourbrothers@2026');
                        db.end();
                    }
                }
            );
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

createUsers();