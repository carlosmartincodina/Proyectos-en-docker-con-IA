docker run -d --name chat-app -p 5000:5000 \
  -e PORT=5000 -e DATA_DIR=/app/data \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -v chat_data:/app/data --restart unless-stopped chat-app
