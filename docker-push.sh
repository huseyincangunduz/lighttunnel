export IMAGE_TAG='latest'
export IMAGE_NAME_PROXY='hcangunduz/lighttunnel-proxy'
export IMAGE_NAME_CLIENT='hcangunduz/lighttunnel-client'
export DOCKER_FILE_PROXY="Dockerfile.proxy"
export DOCKER_FILE_CLIENT="Dockerfile.client"
docker build --file ${DOCKER_FILE_PROXY} -t ${IMAGE_NAME_PROXY}:${IMAGE_TAG} .
docker push ${IMAGE_NAME_PROXY}:${IMAGE_TAG}

docker build --file ${DOCKER_FILE_CLIENT} -t ${IMAGE_NAME_CLIENT}:${IMAGE_TAG} .
docker push ${IMAGE_NAME_CLIENT}:${IMAGE_TAG}
