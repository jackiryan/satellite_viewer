
varying vec3 vNormal;
varying vec4 vPosition;
varying vec4 vColor;

void main() {
    
}



/*
varying vec4 cDirection;

void main() {
    vec4 viewVector = inverse(projectionMatrix) * vec4(0.0, 0.0, 0.0, -1.0);
    cDirection = inverse(viewMatrix) * vec4(viewVector.xyz, 0.0);
    //cDirection = inverse(projectionMatrix * viewMatrix) * vec4(vNormal.x, -vNormal.z, 1.0, 1.0);
    //cDirection.xyz /= cDirection.w;
    

    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
*/