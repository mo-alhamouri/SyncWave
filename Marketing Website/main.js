document.addEventListener('DOMContentLoaded', () => {
    // Add scroll reveal animations
    const observerOptions = {
        threshold: 0.1
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('reveal');
            }
        });
    }, observerOptions);

    document.querySelectorAll('.feature-item').forEach(el => {
        observer.observe(el);
    });

    // Handle download button click
    const downloadBtns = document.querySelectorAll('.download-btn');
    const RELEASE_VERSION = '1.1.2';
    const GITHUB_REPO = 'mo-alhamouri/SyncWave';
    
    const getDownloadUrl = async () => {
        const platform = window.navigator.platform.toLowerCase();
        const userAgent = window.navigator.userAgent.toLowerCase();
        const baseUrl = `https://github.com/${GITHUB_REPO}/releases/download/v${RELEASE_VERSION}`;
        
        if (platform.includes('mac')) {
            // Try to detect Apple Silicon
            let isAppleSilicon = false;
            if (window.navigator.userAgentData) {
                try {
                    const values = await window.navigator.userAgentData.getHighEntropyValues(['architecture']);
                    isAppleSilicon = values.architecture === 'arm';
                } catch (e) {}
            }
            
            // Fallback detection
            if (!isAppleSilicon && (userAgent.includes('arm64') || userAgent.includes('apple silicon'))) {
                isAppleSilicon = true;
            }

            if (isAppleSilicon) {
                return `${baseUrl}/SyncWave-${RELEASE_VERSION}-arm64.dmg`;
            } else {
                // Default to x64 for Intel Macs (electron-builder defaults to no suffix for first arch)
                return `${baseUrl}/SyncWave-${RELEASE_VERSION}.dmg`;
            }
        } else if (platform.includes('win')) {
            return `${baseUrl}/SyncWave-Setup-${RELEASE_VERSION}.exe`;
        }
        // Default to releases page if platform not detected
        return `https://github.com/${GITHUB_REPO}/releases/tag/v${RELEASE_VERSION}`;
    };

    downloadBtns.forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            const url = await getDownloadUrl();
            window.location.href = url;
        });
    });

    // Lightbox Logic
    const lightbox = document.getElementById('lightbox');
    const lightboxImg = lightbox.querySelector('.lightbox-img');
    const lightboxClose = lightbox.querySelector('.lightbox-close');

    document.querySelectorAll('.clickable-image').forEach(item => {
        item.addEventListener('click', () => {
            const imgSrc = item.querySelector('img').src;
            lightboxImg.src = imgSrc;
            lightbox.classList.add('active');
            document.body.style.overflow = 'hidden'; // Prevent scroll
        });
    });

    const closeLightbox = () => {
        lightbox.classList.remove('active');
        document.body.style.overflow = 'auto';
    };

    lightboxClose.addEventListener('click', closeLightbox);
    lightbox.addEventListener('click', (e) => {
        if (e.target === lightbox) closeLightbox();
    });

    // Handle Escape key for Lightbox
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && lightbox.classList.contains('active')) {
            closeLightbox();
        }
    });

    // Smooth scroll for nav links
    document.querySelectorAll('nav a').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            const href = this.getAttribute('href');
            if (href.startsWith('#')) {
                e.preventDefault();
                document.querySelector(href).scrollIntoView({
                    behavior: 'smooth'
                });
            }
        });
    });
});
