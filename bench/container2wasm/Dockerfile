# Benchmark image for the container2wasm harness.
#
# Dependencies are installed natively at image-build time so the *emulated*
# run measures only the CPU-bound `npm run build` burst — the part that
# WebContainer runs near-native and that CPU emulation is expected to tax.
#
# The build context is staged by run.sh: ./app/ is the target project.
FROM node:20-slim
WORKDIR /app
COPY app/ /app/
RUN npm install

# Print a machine-parseable timing line so run.sh can extract the number
# regardless of how noisy the build output is.
CMD ["sh", "-c", "start=$(date +%s%3N); npm run build >/tmp/build.log 2>&1; status=$?; end=$(date +%s%3N); echo \"C2W_BUILD_MS=$((end-start)) C2W_BUILD_STATUS=$status\""]
