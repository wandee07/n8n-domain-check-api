# คู่มือการ Deploy Domain Checker API

## วิธีที่ 1: ใช้ PM2 (แนะนำสำหรับ Production)

### ติดตั้ง PM2
```bash
npm install -g pm2
```

### รันด้วย PM2
```bash
# Start
npm run pm2:start

# Restart
npm run pm2:restart

# Stop
npm run pm2:stop

# ดู logs
npm run pm2:logs

# Auto restart on system reboot
pm2 startup
pm2 save
```

## วิธีที่ 2: ใช้ Apache/XAMPP Proxy

### 1. เปิดใช้งาน mod_proxy ใน Apache
แก้ไข `httpd.conf` ใน XAMPP:
```apache
LoadModule proxy_module modules/mod_proxy.so
LoadModule proxy_http_module modules/mod_proxy_http.so
LoadModule rewrite_module modules/mod_rewrite.so
```

### 2. ตั้งค่า Virtual Host
เพิ่มใน `httpd-vhosts.conf`:
```apache
<VirtualHost *:80>
    ServerName n8n.netdesignhost.com
    DocumentRoot "C:/xampp/htdocs/n8n-domain-check-api"
    
    <Directory "C:/xampp/htdocs/n8n-domain-check-api">
        AllowOverride All
        Require all granted
    </Directory>
    
    # Proxy to Node.js
    ProxyPreserveHost On
    ProxyPass /webhook-test/ http://localhost:3000/webhook-test/
    ProxyPassReverse /webhook-test/ http://localhost:3000/webhook-test/
    ProxyPass /api/ http://localhost:3000/api/
    ProxyPassReverse /api/ http://localhost:3000/api/
</VirtualHost>
```

### 3. รัน Node.js API
```bash
# ใช้ PM2 (แนะนำ)
npm run pm2:start

# หรือรันธรรมดา
npm start
```

## วิธีที่ 3: ใช้ Windows Service (NSSM)

### ติดตั้ง NSSM
ดาวน์โหลดจาก: https://nssm.cc/download

### สร้าง Service
```bash
nssm install DomainCheckerAPI "C:\Program Files\nodejs\node.exe"
nssm set DomainCheckerAPI AppDirectory "C:\xampp\htdocs\n8n-domain-check-api"
nssm set DomainCheckerAPI AppParameters "index.js"
nssm set DomainCheckerAPI DisplayName "Domain Checker API"
nssm start DomainCheckerAPI
```

## การตั้งค่า Firewall

เปิด port 3000 (ถ้าใช้โดยตรง):
```powershell
New-NetFirewallRule -DisplayName "Node.js API Port 3000" -Direction Inbound -LocalPort 3000 -Protocol TCP -Action Allow
```

## การตรวจสอบ

### ทดสอบ API
```bash
# Health check
curl http://localhost:3000/

# Test API
curl "http://localhost:3000/api/check?domain=Test Website"

# Test Webhook
curl -X POST http://localhost:3000/webhook-test/d9c181cb-b202-49ec-a296-597320ca2afa \
  -H "Content-Type: application/json" \
  -d '{"domain":"Test Website"}'
```

### ทดสอบผ่าน Apache (ถ้าใช้ Proxy)
```bash
curl https://n8n.netdesignhost.com/webhook-test/d9c181cb-b202-49ec-a296-597320ca2afa
```

## Environment Variables

สร้างไฟล์ `.env`:
```
DB_CONNECTION=mysql
DB_HOST=150.95.82.37
DB_PORT=3306
DB_DATABASE=devnd_shopup4
DB_USERNAME=devnd_shopup4
DB_PASSWORD=RDFl7Q@ID4Xp
PORT=3000
NODE_ENV=production
```

## Troubleshooting

1. **API ไม่ทำงาน**
   - ตรวจสอบว่า Node.js รันอยู่: `netstat -ano | findstr :3000`
   - ตรวจสอบ logs: `npm run pm2:logs`

2. **ไม่สามารถเข้าถึงจากภายนอก**
   - ตรวจสอบ Firewall
   - ตรวจสอบว่า server listen ที่ `0.0.0.0` ไม่ใช่ `localhost`

3. **Database Connection Error**
   - ตรวจสอบไฟล์ `.env`
   - ตรวจสอบ network connection ไปยัง database server

