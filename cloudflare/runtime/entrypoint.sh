#!/bin/sh
set -eu

: "${SUPABASE_DB_HOST:?Missing SUPABASE_DB_HOST}"
: "${SUPABASE_DB_PORT:=5432}"
: "${SUPABASE_DB_NAME:=postgres}"
: "${SUPABASE_DB_USER:?Missing SUPABASE_DB_USER}"
: "${SUPABASE_DB_PASSWORD:?Missing SUPABASE_DB_PASSWORD}"
: "${TECHRATER_AUTH_TOKEN:?Missing TECHRATER_AUTH_TOKEN}"

echo "TECHRATER_BOOT_CONFIG port=8080 database=${SUPABASE_DB_HOST}:${SUPABASE_DB_PORT}/${SUPABASE_DB_NAME}"

jq -n \
  --arg host "$SUPABASE_DB_HOST" \
  --argjson port "$SUPABASE_DB_PORT" \
  --arg dbname "$SUPABASE_DB_NAME" \
  --arg user "$SUPABASE_DB_USER" \
  --arg passwd "$SUPABASE_DB_PASSWORD" \
  --arg authToken "$TECHRATER_AUTH_TOKEN" \
  '{
    listeners: [{address:"0.0.0.0",port:8080,https:false}],
    db_clients: [{
      name:"default",rdbms:"postgresql",host:$host,port:$port,
      dbname:$dbname,user:$user,passwd:$passwd,is_fast:false,
      number_of_connections:2,timeout:10,
      connect_options:{sslmode:"require"}
    }],
    redis_clients: [{
      name:"default",host:"127.0.0.1",port:6379,db:0,
      is_fast:false,number_of_connections:2,timeout:5
    }],
    app:{
      number_of_threads:1,enable_session:false,document_root:"/app/empty",
      home_page:"index.html",client_max_websocket_message_size:"256K",
      idle_connection_timeout:60,log:{log_level:"TRACE"}
    },
    plugins:[
      {name:"techmino::plugins::Configurator",dependencies:[],config:{block:{enable:false,whiteList:[]}}},
      {name:"techmino::plugins::ConnectionManager",dependencies:[],config:{}},
      {name:"techmino::plugins::PlayerManager",dependencies:[],config:{
        auth:{token:$authToken},
        expirations:{access:60,refresh:10080},
        tokenBucket:{
          ip:{interval:60,maxCount:240},
          login:{interval:60,maxCount:30},
          verify:{interval:60,maxCount:10}
        }
      }},
      {name:"techmino::plugins::RoomManager",dependencies:["techmino::plugins::ConnectionManager"],config:{}},
      {name:"techmino::plugins::HandlerManager",dependencies:["techmino::plugins::ConnectionManager","techmino::plugins::PlayerManager","techmino::plugins::RoomManager"],config:{}},
      {name:"techmino::plugins::NoticeManager",dependencies:[],config:{fallbackLanguage:"en_us"}}
    ]
  }' >/app/techrater/config.json

redis-server --save "" --appendonly no --bind 127.0.0.1 --port 6379 &

attempt=0
until redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 50 ]; then
    echo "TECHRATER_REDIS_FAILED attempts=${attempt}" >&2
    exit 1
  fi
  sleep 0.1
done

echo "TECHRATER_REDIS_READY"
cd /app/techrater
echo "TECHRATER_PROCESS_START"
exec stdbuf -oL -eL ./Techrater 2>&1
