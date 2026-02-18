FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY custom_llm/ ./custom_llm/
COPY tools/       ./tools/
COPY __init__.py  ./

# data/ is mounted as a shared volume at runtime.
# It holds: business_config.json (written by Node after onboarding)
#           token.json           (written by Node after Google OAuth)
RUN mkdir -p data

ENV PYTHONUNBUFFERED=1

EXPOSE 8000
CMD ["uvicorn", "custom_llm.custom_llm:app", "--host", "0.0.0.0", "--port", "8000"]
