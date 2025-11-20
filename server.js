require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const psl = require('psl');
const app = express();
const port = process.env.PORT || 3000;

// Database connection pool
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '3306'),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD?.replace(/^"|"$/g, ''),
    database: process.env.DB_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Middleware เพื่อเปิด CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

    if (value.startsWith('http://') || value.startsWith('https://')) {
        try {
            const url = new URL(value);
            value = url.hostname;
        } catch (err) {
            return null;
        }
    }

    value = value.split('/')[0];
    value = value.split('?')[0];
    value = value.split('#')[0];

    value = value.toLowerCase();
    value = value.replace(/\.$/, '');

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
    if (req.method === 'POST') {
        return req.body?.domain || req.body?.domain_name || req.query?.domain;
    }
    return req.query?.domain;
};

const handleDomainCheck = async (req, res) => {
    const requestedDomain = getDomainFromRequest(req);

    if (!requestedDomain) {
        return res.status(400).json({ 
            success: false,
            error: 'กรุณาระบุชื่อโดเมนใน query parameter หรือ request body (เช่น { "domain": "example.com" })' 
        });
    }

    const normalizedDomain = normalizeDomain(requestedDomain);

    try {
        let domainData = null;
        
        try {
            const searchValues = [
                requestedDomain.trim(),
                requestedDomain.trim().toLowerCase(),
                requestedDomain.trim().toUpperCase()
            ];
            if (normalizedDomain && normalizedDomain !== requestedDomain) {
                searchValues.push(normalizedDomain);
            }
            const uniqueSearchValues = [...new Set(searchValues)];
            
            const tablesToCheck = ['domains'];
            try {
                const [allTables] = await pool.execute('SHOW TABLES');
                for (const table of allTables) {
                    const tableName = Object.values(table)[0];
                    if (!tablesToCheck.includes(tableName)) {
                        tablesToCheck.push(tableName);
                    }
                }
            } catch (err) {
                // Use default tables only
            }
            
            for (const tableName of tablesToCheck) {
                try {
                    const [columns] = await pool.execute(`SHOW COLUMNS FROM \`${tableName}\` LIKE 'domain_name'`);
                    const [expireColumns] = await pool.execute(`SHOW COLUMNS FROM \`${tableName}\` LIKE 'expire_date'`);
                    
                    if (columns.length > 0 && expireColumns.length > 0) {
                        const placeholders = uniqueSearchValues.map(() => '?').join(',');
                        const [rows] = await pool.execute(
                            `SELECT domain_name, expire_date FROM \`${tableName}\` WHERE TRIM(domain_name) IN (${placeholders}) OR domain_name IN (${placeholders}) LIMIT 1`,
                            [...uniqueSearchValues.map(v => v.trim()), ...uniqueSearchValues]
                        );
                        
                        if (rows && rows.length > 0) {
                            domainData = rows[0];
                            break;
                        }
                    }
                } catch (err) {
                    continue;
                }
            }
        } catch (err) {
            console.error('Error searching tables:', err.message);
        }

        const expirationDate = domainData?.expire_date;
        
        if (expirationDate) {
            const expirationDateObj = expirationDate instanceof Date 
                ? expirationDate 
                : new Date(expirationDate);
            
            if (Number.isNaN(expirationDateObj.getTime())) {
                return res.status(404).json({
                    success: false,
                    domainName: normalizedDomain || requestedDomain,
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
            return res.status(404).json({
                success: false,
                domainName: normalizedDomain || requestedDomain,
                error: 'ไม่พบข้อมูลวันหมดอายุสำหรับโดเมนนี้ในฐานข้อมูล'
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

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        success: true,
        message: 'Domain Checker API is running',
        endpoints: {
            check: '/api/check?domain=example.com',
            webhook: '/webhook-test/d9c181cb-b202-49ec-a296-597320ca2afa'
        }
    });
});

// API endpoints
app.get('/api/check', handleDomainCheck);
app.post('/api/check', handleDomainCheck);

// Webhook endpoint สำหรับ n8n
app.post('/webhook-test/d9c181cb-b202-49ec-a296-597320ca2afa', handleDomainCheck);
app.get('/webhook-test/d9c181cb-b202-49ec-a296-597320ca2afa', handleDomainCheck);

// Start Server
const server = app.listen(port, '0.0.0.0', () => {
    console.log(`Domain Checker API listening on port ${port}`);
    console.log(`Webhook URL: http://localhost:${port}/webhook-test/d9c181cb-b202-49ec-a296-597320ca2afa`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        pool.end(() => {
            console.log('Database pool closed');
            process.exit(0);
        });
    });
});

