FROM linuxcontainers/debian-slim:latest

# Install necessary packages
RUN apt-get update && apt-get install -y \
    build-essential \
    git \
    wget \
    zlib1g-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Clone the repository
RUN git clone https://github.com/cnlohr/csgp4.git /csgp4

# CSGP4 is a header only lib, so it is not necessary to build it unless performing unit tests.

# Copy the tle2image server code into the Docker image
COPY server /server
WORKDIR /server
RUN make

RUN chmod +x /server/run_tle2image.sh
RUN mkdir -p /var/www/html/satviewer /var/www/html/satviewer/history

ENTRYPOINT [ "/server/run_tle2image.sh" ]

# Define the default command
CMD ["sh"]
