const express = require('express');
const whoiser = require('whoiser');
const psl = require('psl');
const app = express();
const port = 3000;

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
    if (req.method === 'POST') {
        return req.body?.domain || req.query?.domain;
    }
    return req.query?.domain;
};

const handleDomainCheck = async (req, res) => {
    const requestedDomain = getDomainFromRequest(req);

    if (!requestedDomain) {
        return res.status(400).json({ error: 'กรุณาระบุชื่อโดเมนใน query parameter หรือ request body (เช่น { "domain": "google.com" })' });
    }

    const normalizedDomain = normalizeDomain(requestedDomain);

    if (!normalizedDomain) {
        return res.status(400).json({
            success: false,
            domainName: requestedDomain,
            error: 'รูปแบบโดเมนไม่ถูกต้อง กรุณาระบุชื่อโดเมน เช่น google.com'
        });
    }

    try {
        // 2. ใช้ whoiser ดึงข้อมูล WHOIS
        const whoisData = await whoiser.whoisDomain(normalizedDomain);
        
        // 3. ดึงข้อมูล Expiration Date
        let expirationDate = null;

        // whoiser จะ return object ที่มี key เป็นชื่อ TLD (เช่น .com, .net)
        // เราต้องวนลูปหรือดึง key แรกออกมา
        const domainKeys = Object.keys(whoisData);
        if (domainKeys.length > 0) {
            const firstTldData = whoisData[domainKeys[0]];
            
            // ข้อมูลวันหมดอายุจะอยู่ใน 'Expiry Date' หรือคีย์อื่นที่คล้ายกัน
            const possibleKeys = [
                'Expiry Date',
                'Expiration Date',
                'Registry Expiry Date',
                'Registrar Registration Expiration Date'
            ];

            expirationDate = possibleKeys
                .map((key) => firstTldData[key])
                .find((value) => Boolean(value));
            
            // ถ้ายังไม่เจอ ให้ลองหาใน records ที่อาจจะซ้อนอยู่
            if (!expirationDate && firstTldData.hasOwnProperty('text')) {
                // สำหรับโดเมน .th หรือโดเมนที่ซับซ้อน อาจจะต้อง parse จาก text เอง
                // แต่โดยปกติ whoiser จะดึงมาให้แล้ว
            }
        }
        
        // 4. สร้าง Response JSON
        if (expirationDate) {
            const expirationDateThai = formatThailandDate(expirationDate);

            return res.json({
                success: true,
                domainName: normalizedDomain,
                expirationDate: expirationDate, // วันที่ในรูปแบบ string ที่ n8n อ่านได้
                expirationDateThai: expirationDateThai || expirationDate,
                message: `วันหมดอายุของโดเมน ${normalizedDomain} คือ ${expirationDateThai || expirationDate}`
            });
        } else {
            return res.status(404).json({
                success: false,
                domainName: normalizedDomain,
                error: 'ไม่พบข้อมูลวันหมดอายุสำหรับโดเมนนี้ หรือโดเมนไม่มีอยู่จริง'
            });
        }

    } catch (error) {
        console.error('Error fetching WHOIS data:', error);
        return res.status(500).json({
            success: false,
            domainName: normalizedDomain,
            error: 'เกิดข้อผิดพลาดในการดึงข้อมูล WHOIS'
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

// Start Server
app.listen(port, () => {
    console.log(`Domain Checker API listening at http://localhost:${port}`);
});