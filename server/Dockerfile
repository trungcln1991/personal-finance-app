FROM python:3.12-slim
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends git openssh-client && rm -rf /var/lib/apt/lists/* \
 && git config --system --add safe.directory '*'
WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server/app.py .
COPY index.html add.html transactions.html settings.html ai.html manifest.json sw.js /app/static/
COPY css /app/static/css
COPY js /app/static/js
COPY icons /app/static/icons
RUN useradd -u 1000 -m -s /usr/sbin/nologin app
USER app
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
