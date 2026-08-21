FROM node:18-bullseye-slim

RUN apt-get update && apt-get install -y \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libdbus-1-3 libxkbcommon0 \
    libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
    libasound2 libxss1 \
    ca-certificates libnss3-tools \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Корневые сертификаты Минцифры РФ.
#
# С 10.03.2026 dbo.centrinvest.ru выдан «Russian Trusted Sub CA» под «Russian
# Trusted Root CA» — GlobalSign из цепочки ушёл. Этих корней нет ни в системном
# хранилище Debian, ни в Chromium, поэтому кладём их сами: в системное
# хранилище (для Node и curl) и в базу NSS (её читает Chromium на Linux).
# Файлы лежат в репозитории: это публичные сертификаты, не секреты.
COPY certs/russian_trusted_root_ca.cer /usr/local/share/ca-certificates/russian_trusted_root_ca.crt
COPY certs/russian_trusted_sub_ca.cer  /usr/local/share/ca-certificates/russian_trusted_sub_ca.crt
RUN update-ca-certificates \
 && mkdir -p /root/.pki/nssdb \
 && certutil -d sql:/root/.pki/nssdb -N --empty-password \
 && certutil -d sql:/root/.pki/nssdb -A -t "C,," -n "Russian Trusted Root CA" \
      -i /usr/local/share/ca-certificates/russian_trusted_root_ca.crt \
 && certutil -d sql:/root/.pki/nssdb -A -t "C,," -n "Russian Trusted Sub CA" \
      -i /usr/local/share/ca-certificates/russian_trusted_sub_ca.crt \
 && certutil -d sql:/root/.pki/nssdb -L

# Node доверяет тому же хранилищу — иначе прямые https-запросы к банку
# (минуя страницу) упирались бы в «unable to verify the first certificate».
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt

WORKDIR /app

COPY package*.json ./
RUN npm ci
COPY . .

EXPOSE 3001
CMD ["node", "server.js"]
