FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go test ./... && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/compellent-monitor .

FROM gcr.io/distroless/static-debian13:nonroot
LABEL org.opencontainers.image.source="https://github.com/CarbonNeuron/compellent-monitor" \
      org.opencontainers.image.description="Read-only SNMP dashboard for Dell Compellent Storage Center"
COPY --from=build /out/compellent-monitor /compellent-monitor
USER 65532:65532
EXPOSE 3000
ENTRYPOINT ["/compellent-monitor"]
