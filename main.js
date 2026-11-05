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

    // Copy the one-line installer command
    const copyBtn = document.getElementById('copy-install');
    if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
            const cmd = document.getElementById('install-cmd').textContent.trim();
            try { await navigator.clipboard.writeText(cmd); copyBtn.textContent = 'Copied!'; }
            catch (e) { copyBtn.textContent = 'Select & copy'; }
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
        });
    }

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
