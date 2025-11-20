require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const psl = require('psl');
const app = express();
const port = 3000;

// Database connection pool
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD?.replace(/^"|"$/g, ''), // Remove quotes if present
    database: process.env.DB_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Middleware เพื่อเปิด CORS (หากจำเป็นสำหรับการทดสอบ)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

// Middleware สำหรับแปลง JSON body
app.use(express.json());

const normalizeDomain = (input) => {
    if (!input || typeof input !== 'string') {
        return null;
    }

    let value = input.trim();
    if (!value) {
        return null;
    }

    // Remove protocol if provided
    if (value.startsWith('http://') || value.startsWith('https://')) {
        try {
            const url = new URL(value);
            value = url.hostname;
        } catch (err) {
            return null;
        }
    }

    // Remove path/query/hash if still present
    value = value.split('/')[0];
    value = value.split('?')[0];
    value = value.split('#')[0];

    value = value.toLowerCase();
    value = value.replace(/\.$/, ''); // remove trailing dot

    if (!/^[a-z0-9.-]+$/.test(value) || !value.includes('.')) {
        return null;
    }

    const registrableDomain = psl.get(value);
    return registrableDomain || value;
};

const formatThailandDate = (dateString) => {
    if (!dateString) {
        return null;
    }

    const parsed = new Date(dateString);
    if (Number.isNaN(parsed.getTime())) {
        return null;
    }

    try {
        return parsed.toLocaleString('th-TH', {
            timeZone: 'Asia/Bangkok',
            dateStyle: 'long',
            timeStyle: 'short'
        });
    } catch (err) {
        return null;
    }
};

const getDomainFromRequest = (req) => {
    // n8n อาจส่งข้อมูลมาในรูปแบบต่างๆ
    if (req.method === 'POST') {
        // ลองหาจากหลายที่ (n8n อาจส่งมาในรูปแบบ nested object)
        return req.body?.domain || 
               req.body?.domain_name ||
               req.body?.json?.domain ||
               req.body?.json?.domain_name ||
               req.body?.body?.domain ||
               req.body?.data?.domain ||
               req.query?.domain ||
               req.query?.domain_name;
    }
    return req.query?.domain || req.query?.domain_name;
};

const handleDomainCheck = async (req, res) => {
    // Log incoming request for debugging
    console.log('=== Incoming Request ===');
    console.log('Method:', req.method);
    console.log('URL:', req.url);
    console.log('Body:', JSON.stringify(req.body, null, 2));
    console.log('Query:', req.query);
    
    const requestedDomain = getDomainFromRequest(req);
    console.log('Extracted domain:', requestedDomain);

    if (!requestedDomain) {
        return res.status(400).json({ 
            success: false,
            error: 'กรุณาระบุชื่อโดเมนใน query parameter หรือ request body (เช่น { "domain": "google.com" })',
            receivedData: {
                body: req.body,
                query: req.query
            }
        });
    }

    const normalizedDomain = normalizeDomain(requestedDomain);
    console.log('Normalized domain:', normalizedDomain);

    try {
        // 2. ดึงข้อมูลจาก Database โดยใช้ domain_nam และ expire_date
        // ค้นหาตารางที่มีฟิลด์ domain_nam และ expire_date
        let domainData = null;
        
        try {
            // สร้าง array ของค่าที่จะค้นหา (trim ช่องว่างและลองหลายแบบ)
            const searchValues = [
                requestedDomain.trim(),
                requestedDomain.trim().toLowerCase(),
                requestedDomain.trim().toUpperCase()
            ];
            if (normalizedDomain && normalizedDomain !== requestedDomain) {
                searchValues.push(normalizedDomain);
            }
            // ลบ duplicate values
            const uniqueSearchValues = [...new Set(searchValues)];
            
            // ลองค้นหาในตาราง domains ก่อน (เป็นตารางที่ใช้บ่อย)
            const tablesToCheck = ['domains'];
            try {
                // ดึงรายชื่อตารางทั้งหมดเพื่อหาเพิ่มเติม
                const [allTables] = await pool.execute('SHOW TABLES');
                for (const table of allTables) {
                    const tableName = Object.values(table)[0];
                    if (!tablesToCheck.includes(tableName)) {
                        tablesToCheck.push(tableName);
                    }
                }
            } catch (err) {
                // ถ้าไม่สามารถดึงรายชื่อตารางได้ ให้ใช้แค่ domains
            }
            
            for (const tableName of tablesToCheck) {
                try {
                    // ตรวจสอบว่าตารางมีฟิลด์ domain_name และ expire_date หรือไม่
                    const [columns] = await pool.execute(`SHOW COLUMNS FROM \`${tableName}\` LIKE 'domain_name'`);
                    const [expireColumns] = await pool.execute(`SHOW COLUMNS FROM \`${tableName}\` LIKE 'expire_date'`);
                    
                    if (columns.length > 0 && expireColumns.length > 0) {
                        // Query ด้วยฟิลด์ domain_name และ expire_date
                        // ใช้ LIKE เพื่อค้นหาแบบไม่สนใจ case sensitivity และ trim ช่องว่าง
                        const placeholders = uniqueSearchValues.map(() => '?').join(',');
                        const [rows] = await pool.execute(
                            `SELECT domain_name, expire_date FROM \`${tableName}\` WHERE TRIM(domain_name) IN (${placeholders}) OR domain_name IN (${placeholders}) LIMIT 1`,
                            [...uniqueSearchValues.map(v => v.trim()), ...uniqueSearchValues]
                        );
                        
                        if (rows && rows.length > 0) {
                            domainData = rows[0];
                            console.log(`✓ Found domain in table: ${tableName}`, domainData);
                            break;
                        } else {
                            console.log(`✗ No match in table: ${tableName} for: ${requestedDomain}`);
                        }
                    }
                } catch (err) {
                    // ไม่ log error เพื่อลด noise ใน console
                    continue;
                }
            }
        } catch (err) {
            console.error('Error searching tables:', err.message);
        }

        // 3. ดึงข้อมูล Expiration Date จากผลลัพธ์ database
        const expirationDate = domainData?.expire_date;
        
        // 4. สร้าง Response JSON
        if (expirationDate) {
            // แปลงเป็น Date object ถ้ายังไม่ใช่
            const expirationDateObj = expirationDate instanceof Date 
                ? expirationDate 
                : new Date(expirationDate);
            
            // ตรวจสอบว่า Date object ถูกต้องหรือไม่
            if (Number.isNaN(expirationDateObj.getTime())) {
                return res.status(404).json({
                    success: false,
                    domainName: normalizedDomain,
                    error: 'ข้อมูลวันหมดอายุไม่ถูกต้อง'
                });
            }
            
            const expirationDateString = expirationDateObj.toISOString().split('T')[0];
            const expirationDateThai = formatThailandDate(expirationDateObj);
            const domainName = domainData.domain_name || normalizedDomain || requestedDomain;

            return res.json({
                success: true,
                domainName: domainName,
                expirationDate: expirationDateString,
                expirationDateThai: expirationDateThai || expirationDateString,
                message: `วันหมดอายุของโดเมน ${domainName} คือ ${expirationDateThai || expirationDateString}`
            });
        } else {
            console.log(`✗ Domain not found: ${requestedDomain}`);
            return res.status(404).json({
                success: false,
                domainName: normalizedDomain || requestedDomain,
                error: 'ไม่พบข้อมูลวันหมดอายุสำหรับโดเมนนี้ในฐานข้อมูล',
                searchedFor: requestedDomain,
                normalizedTo: normalizedDomain
            });
        }

    } catch (error) {
        console.error('Error fetching database data:', error);
        return res.status(500).json({
            success: false,
            domainName: normalizedDomain || requestedDomain,
            error: 'เกิดข้อผิดพลาดในการดึงข้อมูลจากฐานข้อมูล: ' + error.message
        });
    }
};

// Endpoint สำหรับเช็ควันหมดอายุโดเมน
app.get('/', (req, res) => {
    res.json({
        message: 'Domain Checker API is running. Use /api/check?domain=example.com'
    });
});

app.get('/api/check', handleDomainCheck);
app.post('/api/check', handleDomainCheck);

// Webhook endpoint สำหรับ n8n
app.post('/webhook-test/d9c181cb-b202-49ec-a296-597320ca2afa', handleDomainCheck);
app.get('/webhook-test/d9c181cb-b202-49ec-a296-597320ca2afa', handleDomainCheck);

// Start Server
app.listen(port, '0.0.0.0', () => {
    console.log(`Domain Checker API listening at http://0.0.0.0:${port}`);
    console.log(`Webhook URL: http://localhost:${port}/webhook-test/d9c181cb-b202-49ec-a296-597320ca2afa`);
});