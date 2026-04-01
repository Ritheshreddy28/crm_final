# Build and run Spring Boot reminder API (Java 17).
# Most hosts set PORT automatically — application.properties uses ${PORT:3001}.

FROM maven:3.9.9-eclipse-temurin-17-alpine AS build
WORKDIR /app
COPY pom.xml .
COPY src ./src
RUN mvn -q -DskipTests package

FROM eclipse-temurin:17-jre-alpine
WORKDIR /app
COPY --from=build /app/target/payment-reminder-server-*.jar /app/app.jar
# Default; platforms like Render/Railway override PORT
ENV PORT=3001
EXPOSE 3001
ENTRYPOINT ["sh", "-c", "exec java -jar /app/app.jar"]
