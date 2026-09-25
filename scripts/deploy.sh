#!/bin/bash
cd /opt/AgroParallel/OrbitX
git pull origin main
npm install --production
pm2 restart OrbitX
echo "Deploy OK - $(date)"
