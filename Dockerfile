FROM node
COPY . .
RUN npm install
CMD npm start