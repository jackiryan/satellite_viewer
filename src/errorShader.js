// shaderLoader.js
import errorVertexShader from './shaders/error/errorVertex.glsl';
import errorFragmentShader from './shaders/error/errorFragment.glsl';


async function loadShader(url) {
    const response = await fetch(url);
    return await response.text();
}

async function initWebGL() {
    const canvas = document.getElementById('shaderCanvas');
    const gl = canvas.getContext('webgl');

    if (!gl) {
        console.error('WebGL not supported');
        return;
    }

    // Compile shaders
    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, errorVertexShader);
    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, errorFragmentShader);

    // Link program
    const program = linkProgram(gl, vertexShader, fragmentShader);
    gl.useProgram(program);

    // Define vertices for a full-screen quad
    const vertices = new Float32Array([
        -1.0, -1.0,
         1.0, -1.0,
        -1.0,  1.0,
         1.0,  1.0,
    ]);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    const positionLocation = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    const timeUniformLocation = gl.getUniformLocation(program, 'iTime');
    const resolutionUniformLocation = gl.getUniformLocation(program, 'iResolution');

    function render(time) {
        time *= 0.001; // convert to seconds

        gl.uniform1f(timeUniformLocation, time);
        gl.uniform2f(resolutionUniformLocation, canvas.width, canvas.height);

        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        requestAnimationFrame(render);
    }

    render();
}

function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Shader compilation failed:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }

    return shader;
}

function linkProgram(gl, vertexShader, fragmentShader) {
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Program linking failed:', gl.getProgramInfoLog(program));
        gl.deleteProgram(program);
        return null;
    }

    return program;
}

initWebGL();
