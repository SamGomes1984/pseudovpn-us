# Use Node 20
FROM node:20-alpine

# Working directory
WORKDIR /app

# Copy dependencies
COPY package*.json ./
RUN npm install --production

# Copy app
COPY . .

# Expose port 8080
EXPOSE 8080

# Start your pseudoVPN worker
CMD ["node", "worker-cloudflare.js"]
