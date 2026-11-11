FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /gitmd ./cmd/gitmd

FROM alpine:3.20
# hugo is only needed for repos configured with type: hugo; harmless to
# always include since it's a small static binary. Installed from upstream
# releases rather than `apk add hugo` — Alpine 3.20 packages 0.125.4, which
# is too old for many current themes (they require 0.146+); the extended
# variant adds Sass/SCSS support most themes also expect.
ARG HUGO_VERSION=0.170.0
ARG HUGO_SHA256=0930754ec22ad2dd1a252f8c31a5e57faccc9d15f1c3d381ddafcb96eeb8aef0
RUN apk add --no-cache git ca-certificates curl \
  && curl -fsSL -o /tmp/hugo.tar.gz \
       "https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_extended_${HUGO_VERSION}_linux-amd64.tar.gz" \
  && echo "${HUGO_SHA256}  /tmp/hugo.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/hugo.tar.gz -C /usr/local/bin hugo \
  && rm /tmp/hugo.tar.gz \
  && apk del curl
COPY --from=build /gitmd /usr/local/bin/gitmd
WORKDIR /app
VOLUME ["/app/data"]
EXPOSE 8080
ENTRYPOINT ["gitmd", "-config", "/app/config.yaml"]
