# SSH-ready Ubuntu image for SAVAGE VPS CREATOR.
#   docker build --build-arg UBUNTU_VERSION=24.04 -t registry.fly.io/<fleet-app>:ubuntu-24.04 vps-image
#   docker build --build-arg UBUNTU_VERSION=22.04 -t registry.fly.io/<fleet-app>:ubuntu-22.04 vps-image
# then `fly auth docker && docker push ...` and set VPS_IMAGE_2404 / VPS_IMAGE_2204.
ARG UBUNTU_VERSION=24.04
FROM ubuntu:${UBUNTU_VERSION}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server sudo curl wget nano htop git ca-certificates iproute2 iputils-ping net-tools \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd /data
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
