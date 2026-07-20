const video = document.getElementById("bg-video");
const slider = document.getElementById("volumeSlider");

video.volume = 0.5;

slider.addEventListener("input", () => {
    video.volume = slider.value / 100;
});
